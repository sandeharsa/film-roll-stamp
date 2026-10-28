"""Inline src/core.js into src/app.html -> index.html"""
import pathlib
root = pathlib.Path(__file__).parent
core = (root/'src/core.js').read_text().replace("if (typeof module !== 'undefined') module.exports = ExifCore;\n", "")
(root/'index.html').write_text((root/'src/app.html').read_text().replace('/*CORE*/', core))
print('built index.html')
