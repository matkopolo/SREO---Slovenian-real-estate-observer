# golang:1.26.11-bookworm, pinned to its digest (Dependabot keeps it current).
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/real-estate-api ./cmd/real-estate-api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sreo-mcp ./cmd/sreo-mcp

# alpine:3.22, pinned to its digest.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 realestate \
    && adduser -S -u 10001 -G realestate realestate
COPY --from=build /out/real-estate-api /usr/local/bin/real-estate-api
COPY --from=build /out/sreo-mcp /usr/local/bin/sreo-mcp
USER 10001:10001
EXPOSE 8080 8090
ENTRYPOINT ["/usr/local/bin/real-estate-api"]
