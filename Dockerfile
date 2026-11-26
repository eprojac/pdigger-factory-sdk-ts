# The SDK in a small image, to try it without installing Node packages (--init lets Ctrl-C stop the endless ones):
#   docker build -t pdigger-factory-sdk-ts .
#   docker run --rm --init -e PDIGGER_FACTORY_URL=http://192.0.2.20:8120 pdigger-factory-sdk-ts   # the quickstart, on the
#     unit's IP address (.local names do not resolve inside a container)
#   docker run --rm --network none pdigger-factory-sdk-ts \
#     node --import ./scripts/fake-preload.mjs examples/quickstart.ts                     # no unit: the fake, offline
#   docker run --rm pdigger-factory-sdk-ts node examples/replay.ts                        # needs internet access
#   docker run --rm --init -p 8130:8130 -e HOST=0.0.0.0 pdigger-factory-sdk-ts node examples/browser/serve.mjs  # viz page
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build
WORKDIR /sdk
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
# the package as it is published (dist/, no runtime dependencies) plus three.js for the viz page, copied from the build
# stage (the lockfile's version: it is a dev dependency, which an install with --omit=dev would leave out); Node 22.18+
# runs the TypeScript examples as they are (type stripping), importing the package by its name.
# `make image-check` checks both uses: the quickstart against the fake, and the viz page's files through serve.mjs.
COPY package.json package-lock.json LICENSE NOTICE README.md ./
COPY --from=build /sdk/node_modules/three ./node_modules/three
COPY --from=build /sdk/dist ./dist
COPY examples ./examples
COPY scripts/fake-preload.mjs ./scripts/
COPY fixtures ./fixtures
USER node
CMD ["node", "examples/quickstart.ts"]
