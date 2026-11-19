# OCR models

English and Vietnamese integer LSTM weights from the official
[tessdata_fast repository](https://github.com/tesseract-ocr/tessdata_fast),
release 4.1.0, commit `65727574dfcd264acbb0c3e07860e4e9e9b22185`.
See LICENSE (Apache-2.0) and manifest.json for source URLs, original and gzipped
SHA-256 hashes. Files are gzipped with Node zlib level 9. The runtime verifies
the bundled compressed hashes before loading these assets and never downloads
models or caches user images to disk. Copy this directory when packaging.

The fast weights replace the initial npm best_int weights, which did not meet
the latency target on the reference page. Model choice is recorded in the OCR
benchmark; recognition quality is checked alongside latency.
