# Read Me First
The following was discovered as part of building this project:

* The original package name 'com.syncvideo.sync-player' is invalid and this project uses 'com.syncvideo.sync_player' instead.

# Getting Started

### Reference Documentation
For further reference, please consider the following sections:

* [Official Apache Maven documentation](https://maven.apache.org/guides/index.html)
* [Spring Boot Maven Plugin Reference Guide](https://docs.spring.io/spring-boot/4.0.1/maven-plugin)
* [Create an OCI image](https://docs.spring.io/spring-boot/4.0.1/maven-plugin/build-image.html)
* [WebSocket](https://docs.spring.io/spring-boot/4.0.1/reference/messaging/websockets.html)

### Guides
The following guides illustrate how to use some features concretely:

* [Using WebSocket to build an interactive web application](https://spring.io/guides/gs/messaging-stomp-websocket/)

### Enable HTTPS and WSS

The application supports TLS through a PKCS12 keystore. Keep the keystore and password outside the repository.
For local development, TLS remains disabled by default.

Set these environment variables in production:

```text
SSL_ENABLED=true
SSL_KEY_STORE=file:/run/secrets/sync-player.p12
SSL_KEY_STORE_PASSWORD=<keystore-password>
SSL_KEY_ALIAS=sync-player
```

Then expose the configured HTTPS port (for example, `server.port=8443`) and access the app with `https://`.
The API and SockJS/WebSocket connections use relative URLs, so they will use HTTPS and WSS automatically.
WebRTC media is separately encrypted by the browser using DTLS-SRTP.

When TLS is terminated at a reverse proxy, configure the proxy to forward HTTPS traffic to the app and set
`FORWARD_HEADERS_STRATEGY=framework`. Do not commit certificates or passwords.

### Maven Parent overrides

Due to Maven's design, elements are inherited from the parent POM to the project POM.
While most of the inheritance is fine, it also inherits unwanted elements like `<license>` and `<developers>` from the parent.
To prevent this, the project POM contains empty overrides for these elements.
If you manually switch to a different parent and actually want the inheritance, you need to remove those overrides.

