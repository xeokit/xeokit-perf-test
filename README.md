# xeokit-perf-test

Experiments to find a workaround for a recent WebGL performance regression bug in IOS 14.3 on iPad Air devices.

## Experiments

We'll add more experiments here as we think of things to try.

### 1. Force medium precision in shaders

xeokit allows the browser to select which level of precision to support in shaders. In this test, we force medium-precision, 
in case the perf regression is due to buggy high-precision support.

[https://xeokit.github.io/xeokit-perf-test/test1/](https://xeokit.github.io/xeokit-perf-test/test1/)

* [Unsuccessful]

### 2. Remove all image buffer allocations

xeokit allocates five different image frame buffers, to support picking and post-effects. This test disables the creation 
of those buffers, in case IOS is handling memory pressure ungracefully. 

Test by drag-rotating with your finger.  

[https://xeokit.github.io/xeokit-perf-test/test2/](https://xeokit.github.io/xeokit-perf-test/test2/)

* [Unsuccessful] 


### 3. Remove all transparent rendering

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test3/](https://xeokit.github.io/xeokit-perf-test/test3/)

* [?] 

### 4. Disable default VBO binds after each frame

Maybe Safari doesn't like the way we disable all the attribute arrays after each frame?

````javascript
const numTextureUnits = WEBGL_INFO.MAX_TEXTURE_UNITS;
for (let ii = 0; ii < numTextureUnits; ii++) {
   gl.activeTexture(gl.TEXTURE0 + ii);
}
gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
gl.bindTexture(gl.TEXTURE_2D, null);

const numVertexAttribs = WEBGL_INFO.MAX_VERTEX_ATTRIBS; // Fixes https://github.com/xeokit/xeokit-sdk/issues/174
for (let ii = 0; ii < numVertexAttribs; ii++) {
   gl.disableVertexAttribArray(ii);
}
````

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test3/](https://xeokit.github.io/xeokit-perf-test/test3/)

* [?]