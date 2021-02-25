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

[https://xeokit.github.io/xeokit-perf-test/test4/](https://xeokit.github.io/xeokit-perf-test/test4/)

* [?]

### 5. Disable WebGL depth mask

Maybe Safari doesn't like how xeokit enables the depth mask before each frame? Let's try disabling that. 

````javascript
gl.depthMask(true);
````

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test5/](https://xeokit.github.io/xeokit-perf-test/test5/)

* [?]

### 6. Smaller geometry batch sizes

Maybe Safari doesn't like how xeokit allocates large arrays on the GPU for batched geometry rendering. Let's try making those arrays shorter.

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test6/](https://xeokit.github.io/xeokit-perf-test/test6/)

* [?]


### 7. Disable all extensions

This will look terrible, but if it renders efficiently it means that one of the WebGL1 extensions is slowing things down.

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test7/](https://xeokit.github.io/xeokit-perf-test/test7/)

### 8. Use default WebGL context attributes

Maybe antialiasing is the culprit? Who knows! Let's try not configuring any WebGL context attributes - we'll comment out where they are configures in the ````Canvas```` component:

````javascript
        this.contextAttr = cfg.contextAttr || {};
        // this.contextAttr.alpha = this.transparent;
        //
        // this.contextAttr.preserveDrawingBuffer = !!this.contextAttr.preserveDrawingBuffer;
        // this.contextAttr.stencil = false;
        // this.contextAttr.premultipliedAlpha = (!!this.contextAttr.premultipliedAlpha);  // False by default: https://github.com/xeokit/xeokit-sdk/issues/251
        // this.contextAttr.antialias = (this.contextAttr.antialias !== false);
````

Test by drag-rotating with your finger.

[https://xeokit.github.io/xeokit-perf-test/test8/](https://xeokit.github.io/xeokit-perf-test/test8/)

* [?]