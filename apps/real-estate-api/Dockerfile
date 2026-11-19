# golang:1.26.11-bookworm, pinned to its digest (Dependabot keeps it current).
FROM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/real-estate-api ./cmd/real-estate-api
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sreo-mcp ./cmd/sreo-mcp

# alpine:3.22, pinned to its digest.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 realestate \
    && adduser -S -u 10001 -G realestate realestate
COPY --from=build /out/real-estate-api /usr/local/bin/real-estate-api
COPY --from=build /out/sreo-mcp /usr/local/bin/sreo-mcp
USER 10001:10001
EXPOSE 8080 8090
ENTRYPOINT ["/usr/local/bin/real-estate-api"]
