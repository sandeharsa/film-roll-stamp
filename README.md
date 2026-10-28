# Roll Stamp

A small web app for writing EXIF to film scans: one date, a start time that steps a few seconds per frame, plus camera body, lens, ISO and film stock across the whole roll.

Everything runs in the browser. Nothing is uploaded, and the image data is never re-encoded.

## Using it

- **iPhone / Android:** open the site in Safari or Chrome and add it to your Home Screen. Tap **Choose scans** and pick the files from Files rather than the Photo Library, set the roll details, then tap **Write EXIF**. Save the results with **Save to Photos / Share…** or as a ZIP.
- **Mac / PC in Chrome, Edge or Arc:** **Open folder** writes tagged copies into an `exif` subfolder, or overwrites the originals.
- **Safari / Firefox on desktop:** pick files or a folder; results download as a ZIP.

## What gets written

| Field | EXIF tag |
| --- | --- |
| Date and time | DateTimeOriginal, DateTime, OffsetTimeOriginal (DateTimeDigitized is kept as the lab's scan time unless you choose otherwise) |
| Body | Make, Model |
| Lens | LensMake, LensModel, FocalLength, FocalLengthIn35mmFilm (scaled for medium format), FNumber (optional) |
| ISO | ISOSpeedRatings |
| Film stock | UserComment, and optionally ImageDescription (shown as Caption in Lightroom) |
| Source | FileSource = film scanner |

Fields left blank keep whatever is already in the file.

JPEG: the Exif segment is rebuilt and the compressed image data is copied byte for byte. Embedded EXIF thumbnails and maker notes are dropped.

TIFF: a new tag directory is appended and the header is repointed, so the strips are never moved.

## Development

Edit `src/app.html` (UI) and `src/core.js` (EXIF reader/writer), then run `python3 build.py` to regenerate the single-file `index.html`.
