# make test      the unit tests in Docker with no network, as CI runs them (types, lint, formatting, tests at 100 %
#                coverage, build, API reference), on both bases of Dockerfile.test, Node 26 and then 22; make test-26 or
#                make test-22 runs one; make test DOCKER_BUILD_FLAGS=--no-cache rebuilds the images from nothing
# make check     the same checks here (npm ci first)
# make integration  the opt-in tests in the test image, with the network: the read-only checks of the unit at
#                PDIGGER_FACTORY_URL and/or the complete recordings in the folder PDIGGER_FACTORY_RECORDINGS
# make docs      the API reference in docs/api (TypeDoc)
# make pictures  redraw docs/img from the code's output (the screenshots need a local Chrome)
# make viz       serve the viz example on http://127.0.0.1:8130/examples/browser/
# make image     the try-it image (Dockerfile)
# make image-check  build it and check it offline: the quickstart against the fake, the viz page's files
# make clean     remove build output, coverage and the API reference

IMAGE := pdigger-factory-sdk-ts-test
# Dockerfile.test's two bases: the newest Node LTS (image $(IMAGE)) and the oldest the gate keeps ($(IMAGE):node22)
NODE_NEW := 26
NODE_OLD := 22
DOCKER_BUILD_FLAGS ?=

.PHONY: test test-$(NODE_NEW) test-$(NODE_OLD) test-image test-image-$(NODE_OLD) integration check docs pictures viz \
	image image-check clean

test: test-$(NODE_NEW) test-$(NODE_OLD)

test-$(NODE_NEW): test-image
	docker run --rm --network none $(IMAGE)

test-$(NODE_OLD): test-image-$(NODE_OLD)
	docker run --rm --network none $(IMAGE):node$(NODE_OLD)

test-image:
	docker build $(DOCKER_BUILD_FLAGS) -t $(IMAGE) -f Dockerfile.test .

test-image-$(NODE_OLD):
	docker build $(DOCKER_BUILD_FLAGS) --build-arg NODE=$(NODE_OLD) -t $(IMAGE):node$(NODE_OLD) -f Dockerfile.test .

# The unit's address must be one the container can reach (an IP address; .local names do not resolve in Docker).
integration: test-image
	@test -n "$(PDIGGER_FACTORY_URL)$(PDIGGER_FACTORY_RECORDINGS)" || { echo 'make integration: set PDIGGER_FACTORY_URL=http://<unit>:8120 and/or PDIGGER_FACTORY_RECORDINGS=<folder>' >&2; exit 2; }
	docker run --rm \
		$(if $(PDIGGER_FACTORY_URL),-e PDIGGER_FACTORY_URL="$(PDIGGER_FACTORY_URL)") \
		$(if $(PDIGGER_FACTORY_RECORDINGS),-e PDIGGER_FACTORY_RECORDINGS=/recordings -v "$(abspath $(PDIGGER_FACTORY_RECORDINGS))":/recordings:ro) \
		$(IMAGE) npm run test:integration

check:
	npm run check

docs:
	npm run docs

pictures:
	npm run pictures

viz:
	npm run viz

image:
	docker build $(DOCKER_BUILD_FLAGS) -t pdigger-factory-sdk-ts .

image-check: image
	IMAGE=pdigger-factory-sdk-ts ./scripts/image-check.sh

clean:
	npm run clean
