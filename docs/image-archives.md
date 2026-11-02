# Docker image archive transport

The host-only `/docker` entry point exposes `Docker.saveImage(image, destination)`
and `Docker.loadImage(source)`. Export streams to a new file with mode `0600` and
refuses overwrites. Import streams a local tar to the Engine, limits response
metadata to 1 MiB, rejects daemon errors and returns parsed loaded image IDs.

These are transport mechanisms, not backup compatibility or ownership policy.
The caller supplies approved image identities and protected paths, validates the
returned IDs, holds its operation lock and owns interruption/recovery behavior.
Image archives can contain credentials and other private filesystem data. Do not
return them through public browser state or treat them as application-consistent
backups without the product's shutdown and volume handling.

`tests/image-backups.test.ts` uses an isolated Unix-socket HTTP fixture to exercise
streaming, refusal to overwrite, import receipts and daemon errors. The normal SDK
Docker suite exercises generic lifecycle behavior but does not by itself establish
real image save/load recovery. Consumer Docker recovery tests must also pass before
runtime acceptance. Source preservation is not a deployment or release.
