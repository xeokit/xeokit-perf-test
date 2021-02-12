# xeokit-perf-test

Experiments to find a workaround for a recent WebGL performance regression bug in IOS 14.3 on iPad Air devices.

## Force medium precision in shaders

xeokit allows the browser to select which level of precision to support in shaders. In this test, we force medium-precision, 
in case the perf regression is due to buggy high-precision support.

https://xeokit.github.io/xeokit-perf-test/test1/

## Remove all frame buffer allocations

xeokit allocates five different frame buffers, to support picking and post-effects. This test disables the creation 
of those buffers, in IOS is handling memory pressure ungracefully. 

Test by drag-rotating with your finger.  

https://xeokit.github.io/xeokit-perf-test/test2/