package com.guidewire

uses com.gradle.cloudservices.buildscan.export.GroupingPublisher
uses com.gradle.cloudservices.buildscan.export.FindFirstPublisher
uses com.guidewire.json.BuildMetadata
uses com.guidewire.json.BuildMetadataUtil
uses ratpack.exec.ExecResult
uses ratpack.exec.Promise
uses ratpack.exec.util.ParallelBatch
uses ratpack.http.HttpUrlBuilder
uses ratpack.http.client.HttpClient
uses ratpack.http.client.RequestSpec
uses ratpack.sse.Event
uses ratpack.sse.ServerSentEventStreamClient
uses ratpack.stream.TransformablePublisher
uses ratpack.test.exec.ExecHarness

uses java.net.URI
uses java.time.Instant
uses java.time.ZoneOffset
uses java.time.ZonedDateTime

class BuildScanExportClient {

  static final var _server : String as readonly SERVER = serverconfig.serverUrl
  static final var _parallelism : int as readonly PARALLELISM = serverconfig.serverParallelism.toInt()

  static final var _gzip : block(rs:RequestSpec) : void as readonly GZIP = \ rs -> rs.getHeaders().set("Accept-Encoding", "gzip")

  static function getBuildById(buildId : String) : BuildMetadata {
    return getFirstEventForBuild(BuildMetadata, buildId)
  }

  static function getMostRecentBuilds(n : int) : List<BuildMetadata> {
    return BuildMetadataUtil.getMostRecent(n, getListOfBuilds())
  }
  
  /**
   * Gets all BuildMetadata events from beginning of time, defined as 2016-12-15 00:00 UTC
   * @return List of Events; all Data properties are assignable to BuildMetadata
   */
  static function getListOfBuilds() : List<BuildMetadata> {
    return getListOfBuildsSince(ZonedDateTime.of(2016, 12, 15, 0, 0, 0, 0, ZoneOffset.UTC))
  }

  /**
   * Gets all BuildMetadata events between the provided dates (inclusive)
   * @return List of Events; all Data properties are assignable to BuildMetadata
   */
  static function getListOfBuildsBetween(from : ZonedDateTime, to : ZonedDateTime) : List<BuildMetadata> {
    var builds = getListOfBuildsSince(from)
    return builds.where( \ e -> e.timestamp <= to.toInstant().toEpochMilli())
  }
  
  /**
   * Gets all BuildMetadata events since the provided date
   * @return List of Events; all Data properties are assignable to BuildMetadata
   */
  static function getListOfBuildsSince(date : ZonedDateTime) : List<BuildMetadata> {
    var base = new URI(SERVER)
    
    var retval = ExecHarness.yieldSingle(\ exec -> {
      var httpClient = HttpClient.of(\ s -> s.poolSize(PARALLELISM))
      var sseClient = ServerSentEventStreamClient.of(httpClient)
      
      var timestamp = Instant.from(date).toEpochMilli()
      var timestampString = Long.toString(timestamp)
      
      var listingUri = HttpUrlBuilder.base(base)
          .path("build-export/v1/builds/since")
          .segment(timestampString, {})
          .params({"stream", ""})
          .build()
      
      return sseClient.request(listingUri, GZIP)
          .flatMap(\ buildStream -> 
              new GroupingPublisher(buildStream, PARALLELISM)
                  .bindExec()
                  .toPromise()) //Note: if the result set exceeds the PARALLELISM value, it will be partitioned into sublists. Use toList() here or increase PARALLELISM. 
    })
    
    return retval.getValueOrThrow()?.whereEventTypeIs(BuildMetadata)
  }
  
  static function getAllEventsForBuild(build : BuildMetadata) : List<Event> {
    return getAllEventsForBuild(build.publicBuildId)
  }

  static function getAllEventsForBuild(publicBuildId : String) : List<Event> {
    return getAllEventsForBuild(publicBuildId, {})
  }
  
  static function getAllEventsForBuild(publicBuildId : String, criteria : Map<AdditionalMatchingCriteria, Boolean>) : List<Event> {
    var base = new URI(SERVER)

    var buildUriFunction: block(s: String): URI = \ buildId -> HttpUrlBuilder.base(base)
        .path("build-export/v1/build")
        .segment(buildId, {})
        .segment("events", {})
        .params({"stream", ""})
        .build()

    return ExecHarness.yieldSingle(\exec -> {
      var httpClient = HttpClient.of(\s -> s.poolSize(PARALLELISM))
      var sseClient = ServerSentEventStreamClient.of(httpClient)

//      print("\nParsing build " + publicBuildId)
      var buildEventUri = buildUriFunction(publicBuildId)
      return sseClient.request(buildEventUri, GZIP)
          .flatMap(\events -> events.toList())
    }).getValueOrThrow().where(\e -> e.Id != publicBuildId) //filter out the BuildMetadata event, easily recognizable by its Id property
  }

  static function getFirstEventForBuild<R extends Dynamic>(eventType : Type<R>, build : BuildMetadata) : R {
    return BuildScanExportClient.getFirstEventForBuild(eventType, build.publicBuildId)
  }
  
  static function getFirstEventForBuild<R extends Dynamic>(eventType : Type<R>, publicBuildId : String) : R {
    var base = new URI(SERVER)

    var buildUriFunction(buildId: String): URI = \ buildId -> HttpUrlBuilder.base(base)
        .path("build-export/v1/build")
        .segment(buildId, {})
        .segment("events", {})
        .params({"stream", ""})
        .build()
    
    //var eventForSubtype: block(event : Object): Event = \ e -> (e as Event).Event == eventType.RelativeName ? (e as Event) : null

//    print("\nParsing build " + publicBuildId + ", looking for first " + R.RelativeName) //TODO debug logging?

    var result = ExecHarness.yieldSingle( \ exec -> {
      var httpClient = HttpClient.of(\s -> s.poolSize(PARALLELISM))
      var sseClient = ServerSentEventStreamClient.of(httpClient)
      var buildEventUri = buildUriFunction(publicBuildId)

      return sseClient.request(buildEventUri, GZIP)
        .flatMap( \ events ->
            new FindFirstPublisher(events, \ e -> e.TypeMatches(eventType) ? e : null)
                .toPromise()
        )
    })
    
    try {
      return result.getValueOrThrow().Json as R
    }
    catch(npe: NullPointerException) {
      print("Build ${publicBuildId} did not contain any events of type ${eventType.RelativeName}")
      return null
    }
  }
  
/*  
  static function getAllEventsForBuild<R extends Dynamic>(eventType : Type<R>, build : BuildMetadata) : List<R> {
    return BuildScanExportClient.getAllEventsForBuild(eventType, build.publicBuildId)
  }
  
  //TODO make this work in java first
  static function getAllEventsForBuild<R extends Dynamic>(eventType : Type<R>, publicBuildId : String) : List<R> {
    var base = new URI(SERVER)

    var buildUriFunction: block(s: String): URI = \ buildId -> HttpUrlBuilder.base(base)
        .path("build-export/v1/build")
        .segment(buildId, {})
        .segment("events", {})
        .params({"stream", ""})
        .build()

    var retval = ExecHarness.yieldSingle(\exec -> {
      var httpClient = HttpClient.of(\s -> s.poolSize(PARALLELISM))
      var sseClient = ServerSentEventStreamClient.of(httpClient)

//      print("\nParsing build " + publicBuildId)
      var buildEventUri = buildUriFunction(publicBuildId)
      return sseClient.request(buildEventUri, GZIP)
          .flatMap( \ eventStream ->
            new GroupingPublisher(eventStream, PARALLELISM)
              .bindExec()
              .flatMap( \ events -> {
//                var promises : Iterable<Promise<Event>> = com.google.common.collect.Iterables.transform(events, \ event -> {
                var promises : List<Promise<Event>> = events.map( \ event -> {
                  print("Processing event ${event.Id}: ${event.Event}")
                  return Promise.value(event)
                })
//                new FindFirstPublisher(events, \ e -> e.)
//                  .toPromise()
//                //events.flatMap( \ e -> e.TypeMatches(eventType) ? Promise.async(e) : null)
                return ParallelBatch.of(promises).yield() //returns Promise<List<Event<>>>
              }) //returning TP<List<Event>>
              
          )
    }).getValueOrThrow() //todo cast as List<R>?
        
        //.where(\e -> e.Id != publicBuildId) //filter out the BuildMetadata event, easily recognizable by its Id property   
    return {}
  }
  */
  
  static function filterByCriteria(builds : List<BuildMetadata>, criteria : List<AdditionalMatchingCriteria>) : List<BuildMetadata> {
    var status = new HashMap<AdditionalMatchingCriteria, Boolean>()
    criteria.each(\ it -> status.put(it, false))

    var base = new URI(SERVER)

    var buildUriFunction(buildId: String): URI = \ buildId -> HttpUrlBuilder.base(base)
        .path("build-export/v1/build")
        .segment(buildId, {})
        .segment("events", {})
        .params({"stream", ""})
        .build()
    
    var retval = new ArrayList<BuildMetadata>()
    
    for(build in builds) {
      status.eachValue(\value -> false) //reset the map
      
      var result = ExecHarness.yieldSingle( \ exec -> {
        var httpClient = HttpClient.of(\s -> s.poolSize(PARALLELISM))
        var sseClient = ServerSentEventStreamClient.of(httpClient)
        var buildEventUri = buildUriFunction(build.publicBuildId)

        return sseClient.request(buildEventUri, GZIP)
            .flatMap( \ events ->
                new FindFirstPublisher(events, \ e -> e.TypeMatches(eventType) ? e : null)
                    .toPromise()
            )
      })
      
      if(status.values().allMatch(\value -> true)) {
        retval.add(build)
      }
    }
    
    
    return retval
  }
  
}