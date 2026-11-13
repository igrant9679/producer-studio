# lottie-web (canvas, light build)

- Package: `lottie-web@5.13.0` from the npm registry (tarball sha512 `+gfBXl6sxXMPe8tKQm7qzLnUy5DUPJPKIyRHwtpCpyUEYjHYRJC/5gjUvdkuO2c3JllrPtHXH5UJJK8LRYl5yQ==`, checked).
- File: `build/player/lottie_light_canvas.min.js`, copied unchanged as `lottie.js` (sha256 `0930bfecb5b5dad59dd9049a139fa957e57f70e0805fc94a311204e524e45e28`).
- Licence: MIT (`LICENSE`, from the package).
- Why the light canvas build: it has no support for Lottie expressions (JavaScript inside an animation file), so
  nothing in an animation can run code; the drawing sandbox renders with the canvas renderer, frame by frame.
- To update: download a newer tarball, check its integrity against the registry, copy the same file, update the
  version and both hashes here (a test checks the sha256).
