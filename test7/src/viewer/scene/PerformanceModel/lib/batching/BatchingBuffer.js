import {WEBGL_INFO} from "../../../webglInfo.js";

const bigIndicesSupported = false;

/**
 * @private
 */
class BatchingBuffer {

    constructor(maxGeometryBatchSize = 5000000) {

        if (bigIndicesSupported) {
            if (maxGeometryBatchSize > 5000000) {
                maxGeometryBatchSize = 5000000;
            }
        } else {
            if (maxGeometryBatchSize > 65530) {
                maxGeometryBatchSize = 65530;
            }
        }

        this.maxVerts = maxGeometryBatchSize;
        this.maxIndices = maxGeometryBatchSize * 3; // Rough rule-of-thumb
        this.positions = [];
        this.colors = [];
        this.normals = [];
        this.pickColors = [];
        this.flags = [];
        this.flags2 = [];
        this.offsets = [];
        this.indices = [];
        this.edgeIndices = [];
    }
}

export {BatchingBuffer};