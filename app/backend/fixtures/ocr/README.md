# Public OCR reference inputs

Original synthetic documents created for this repository, with no personal data
or third-party scans. PNGs are frozen benchmark inputs; manifest.json records
their exact SHA-256 hashes, pixel dimensions, expected text and word counts.
SVGs show the source layout. Do not regenerate PNGs during benchmarking: host
fonts can change pixels and invalidate comparisons.

- standard-page: A4 at 2480 x 3508 pixels, 36 lines/360 English words. This also
  guards against repeated lines being incorrectly segmented into columns.
- varied-page: same A4 dimensions, 34 lines/393 words in five original paragraphs.
- english-small and vietnamese-small: format/language/orientation checks.

To intentionally regenerate, run scripts/make-ocr-fixtures.mjs on a machine with
Arial or a compatible font, review the resulting images and commit the updated
PNGs and manifest together. Performance results must name the input hashes.
