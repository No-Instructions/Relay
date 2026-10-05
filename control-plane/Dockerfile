# Control plane: PocketBase + pb_hooks + pb_migrations + patched y-sign.
# Both stages are Debian trixie: the glibc Rust binary does not run on Alpine.

FROM rust:1.89-slim-trixie AS ysign
ARG RELAY_SERVER_VERSION=0.12.7
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${RELAY_SERVER_VERSION} https://github.com/No-Instructions/relay-server.git .
# Adds the audience claim and optional user/channel; see README.md.
COPY y-sign.patch /tmp/y-sign.patch
RUN git apply /tmp/y-sign.patch
RUN cd crates && cargo build --release --locked -p y-sign

FROM debian:trixie-slim AS pocketbase
ARG PB_VERSION=0.40.4
ARG PB_SHA256=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/pb.zip \
      https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip \
 && echo "${PB_SHA256}  /tmp/pb.zip" | sha256sum -c - \
 && unzip /tmp/pb.zip pocketbase -d /out

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=pocketbase /out/pocketbase /app/pocketbase
COPY --from=ysign /src/crates/target/release/y-sign /usr/local/bin/y-sign
COPY pb_hooks /app/pb_hooks
COPY pb_migrations /app/pb_migrations

# uid 10001 matches the pod securityContext in infra 242-relay.tf.
RUN useradd --system --uid 10001 --home-dir /data pocketbase && mkdir -p /data && chown 10001 /data
USER 10001
EXPOSE 8090

# Schema lives in pb_migrations, so dashboard edits must not write new ones.
CMD ["/app/pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/data/pb_data", "--hooksDir=/app/pb_hooks", "--migrationsDir=/app/pb_migrations", "--automigrate=false", "--hooksWatch=false"]
