"""Inline src/core.js into each page in src/ -> index.html, contact.html"""
import pathlib
root = pathlib.Path(__file__).parent
core = (root/'src/core.js').read_text().replace("if (typeof module !== 'undefined') module.exports = ExifCore;\n", "")
for src, out in [('app.html', 'index.html'), ('contact.html', 'contact.html')]:
    (root/out).write_text((root/'src'/src).read_text().replace('/*CORE*/', core))
    print('built', out)
