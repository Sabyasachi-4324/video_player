# Friends Video Player

Friends Video Player is a Spring Boot web application for watching videos together in synchronized rooms. It provides local-file sync, YouTube watch parties, direct browser-to-browser streaming, chat, reactions, and optional camera and microphone sharing.

## Features

- Local File Sync: each participant selects the same video file locally.
- YouTube Watch Party: load and control a YouTube video for everyone in the room.
- Direct Stream: one host broadcasts a local video to connected viewers.
- Room chat, reactions, presence, host ownership, and room locking.
- WebRTC camera and microphone sharing with draggable floating camera tiles.
- Automatic WebSocket reconnect handling.

## Requirements

- Java 17 or newer.
- Maven, or the included Maven wrapper.
- A modern browser with WebSocket and WebRTC support.
- Camera and microphone features require `localhost` or HTTPS. Browsers normally block media access on an insecure remote HTTP origin.

## Run Locally

From the project directory:

```bash
./mvnw spring-boot:run
```

On Windows PowerShell:

```powershell
.\mvnw.cmd spring-boot:run
```

Open [http://localhost:8080](http://localhost:8080). The server listens on port `8080` by default. Set `PORT` to use another port:

```text
PORT=9090
```

## Using the Application

1. Choose a watch mode from the home page.
2. Create a room and share the room code with friends.
3. Other participants enter their name and the room code to join.
4. Select or load the video according to the chosen mode.
5. Use the camera and microphone controls after joining the room.
6. Use the Exit Room control when finished. Browser Back, refresh, and page navigation also clean up the current room session.

For local-file sync, every participant should choose a file with the same duration. The file itself stays on each participant's device.

## Tests

Run the test suite with the Maven wrapper:

```bash
./mvnw test
```

Windows PowerShell:

```powershell
.\mvnw.cmd test
```

Check the browser scripts before committing frontend changes:

```bash
node --check src/main/resources/static/script-local.js
node --check src/main/resources/static/script-youtube.js
node --check src/main/resources/static/script-stream.js
```

## Docker

Build and run the supplied container image:

```bash
docker build -t sync-player .
docker run --rm -p 8080:8080 sync-player
```

The Docker image builds with Maven and runs on OpenJDK 17. The application binds to `0.0.0.0` inside the container.

## Architecture Notes

- Spring Boot serves the static pages and REST room endpoints.
- STOMP over SockJS is used for room events, synchronization, chat, and WebRTC signaling.
- Room membership and video state are held in application memory. Restarting the server removes active rooms.
- WebRTC media is sent directly between browsers when network conditions allow it. The server forwards signaling messages but does not store camera or microphone media.
- The application uses the `com.syncvideo.sync_player` Java package because the original package name containing a hyphen is not valid Java syntax.

## HTTPS and WSS

Camera and microphone access on a deployed site requires HTTPS. The application supports TLS through a PKCS12 keystore. Keep the keystore and password outside the repository.

Set these environment variables in production:

```text
SSL_ENABLED=true
SSL_KEY_STORE=file:/run/secrets/sync-player.p12
SSL_KEY_STORE_PASSWORD=<keystore-password>
SSL_KEY_ALIAS=sync-player
```

Expose the configured HTTPS port, for example with `server.port=8443`, and access the application with `https://`. The API and SockJS/WebSocket connections use relative URLs, so they use HTTPS and WSS automatically. WebRTC media is separately encrypted by the browser using DTLS-SRTP.

When TLS is terminated by a reverse proxy, forward the original HTTPS headers and keep this setting enabled:

```text
FORWARD_HEADERS_STRATEGY=framework
```

Do not commit certificates, keystores, or passwords.

## Reference Documentation

- [Apache Maven documentation](https://maven.apache.org/guides/index.html)
- [Spring Boot documentation](https://docs.spring.io/spring-boot/4.0.1/)
- [Spring WebSocket and STOMP guide](https://spring.io/guides/gs/messaging-stomp-websocket/)
- [WebRTC API documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)

## Maven Parent Overrides

The Maven parent can inherit metadata such as licenses and developers. This project keeps empty overrides for those fields in `pom.xml`. If the parent is changed and that metadata is needed, remove the empty overrides.

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

