import {WEBGL_INFO} from "../../../webglInfo.js";
import {ENTITY_FLAGS} from '../entityFlags.js';
import {RENDER_PASSES} from '../renderPasses.js';

import {math} from "../../../math/math.js";
import {buildEdgeIndices} from '../../../math/buildEdgeIndices.js';
import {RenderState} from "../../../webgl/RenderState.js";
import {ArrayBuf} from "../../../webgl/ArrayBuf.js";
import {geometryCompressionUtils} from "../../../math/geometryCompressionUtils.js";
import {getInstancingRenderers} from "./InstancingRenderers.js";

const bigIndicesSupported = false;
const MAX_VERTS = bigIndicesSupported ? 5000000 : 65530;
const quantizedPositions = new Uint16Array(MAX_VERTS * 3);
const compressedNormals = new Int8Array(MAX_VERTS * 3);
const tempUint8Vec4 = new Uint8Array(4);

const tempVec4a = math.vec4([0, 0, 0, 1]);
const tempVec4b = math.vec4([0, 0, 0, 1]);
const tempVec4c = math.vec4([0, 0, 0, 1]);

const tempVec3fa = new Float32Array(3);

/**
 * @private
 */
class InstancingLayer {

    /**
     * @param model
     * @param cfg
     * @param cfg.layerIndex
     * @param cfg.primitive
     * @param cfg.positions Flat float Local-space positions array.
     * @param cfg.normals Flat float normals array.
     * @param cfg.indices Flat int indices array.
     * @param cfg.edgeIndices Flat int edges indices array.
     * @param cfg.edgeThreshold
     * @param cfg.rtcCenter
     */
    constructor(model, cfg) {

        /**
         * Index of this InstancingLayer in PerformanceModel#_layerList
         * @type {Number}
         */
        this.layerIndex = cfg.layerIndex;

        this._instancingRenderers = getInstancingRenderers(model.scene);
        this.model = model;
        this._aabb = math.collapseAABB3();

        let primitiveName = cfg.primitive || "triangles";
        let primitive;

        const gl = model.scene.canvas.gl;

        switch (primitiveName) {
            case "points":
                primitive = gl.POINTS;
                break;
            case "lines":
                primitive = gl.LINES;
                break;
            case "line-loop":
                primitive = gl.LINE_LOOP;
                break;
            case "line-strip":
                primitive = gl.LINE_STRIP;
                break;
            case "triangles":
                primitive = gl.TRIANGLES;
                break;
            case "triangle-strip":
                primitive = gl.TRIANGLE_STRIP;
                break;
            case "triangle-fan":
                primitive = gl.TRIANGLE_FAN;
                break;
            default:
                model.error(`Unsupported value for 'primitive': '${primitiveName}' - supported values are 'points', 'lines', 'line-loop', 'line-strip', 'triangles', 'triangle-strip' and 'triangle-fan'. Defaulting to 'triangles'.`);
                primitive = gl.TRIANGLES;
                primitiveName = "triangles";
        }

        const stateCfg = {
            primitiveName: primitiveName,
            primitive: primitive,
            positionsDecodeMatrix: math.mat4(),
            numInstances: 0,
            obb: math.OBB3(),
            rtcCenter: null
        };

        const preCompressed = (!!cfg.positionsDecodeMatrix);

        if (cfg.positions) {

            if (preCompressed) {

                let normalized = false;
                stateCfg.positionsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, cfg.positions, cfg.positions.length, 3, gl.STATIC_DRAW, normalized);
                stateCfg.positionsDecodeMatrix.set(cfg.positionsDecodeMatrix);

                let localAABB = math.collapseAABB3();
                math.expandAABB3Points3(localAABB, cfg.positions);
                geometryCompressionUtils.decompressAABB(localAABB, stateCfg.positionsDecodeMatrix);
                math.AABB3ToOBB3(localAABB, stateCfg.obb);

            } else {

                let lenPositions = cfg.positions.length;
                let localAABB = math.collapseAABB3();
                math.expandAABB3Points3(localAABB, cfg.positions);
                math.AABB3ToOBB3(localAABB, stateCfg.obb);
                quantizePositions(cfg.positions, lenPositions, localAABB, quantizedPositions, stateCfg.positionsDecodeMatrix);
                let normalized = false;
                stateCfg.positionsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, quantizedPositions, lenPositions, 3, gl.STATIC_DRAW, normalized);
            }
        }

        if (cfg.normals) {

            if (preCompressed) {

                const normalized = true; // For oct-encoded UInt8
                stateCfg.normalsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, cfg.normals, cfg.normals.length, 3, gl.STATIC_DRAW, normalized);

            } else {

                const lenCompressedNormals = octEncodeNormals(cfg.normals, cfg.normals.length, compressedNormals, 0);
                const normalized = true; // For oct-encoded UInt8
                stateCfg.normalsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, compressedNormals, lenCompressedNormals, 3, gl.STATIC_DRAW, normalized);
            }
        }

        if (cfg.indices) {
            stateCfg.indicesBuf = new ArrayBuf(gl, gl.ELEMENT_ARRAY_BUFFER, bigIndicesSupported ? new Uint32Array(cfg.indices) : new Uint16Array(cfg.indices), cfg.indices.length, 1, gl.STATIC_DRAW);
        }

        let edgeIndices = cfg.edgeIndices;
        if (!edgeIndices) {
            edgeIndices = buildEdgeIndices(cfg.positions, cfg.indices, null, cfg.edgeThreshold || 10);
        }

        stateCfg.edgeIndicesBuf = new ArrayBuf(gl, gl.ELEMENT_ARRAY_BUFFER, bigIndicesSupported ? new Uint32Array(edgeIndices) : new Uint16Array(edgeIndices), edgeIndices.length, 1, gl.STATIC_DRAW);

        this._state = new RenderState(stateCfg);

        // These counts are used to avoid unnecessary render passes
        this._numPortions = 0;
        this._numVisibleLayerPortions = 0;
        this._numTransparentLayerPortions = 0;
        this._numXRayedLayerPortions = 0;
        this._numHighlightedLayerPortions = 0;
        this._numSelectedLayerPortions = 0;
        this._numClippableLayerPortions = 0;
        this._numEdgesLayerPortions = 0;
        this._numPickableLayerPortions = 0;
        this._numCulledLayerPortions = 0;

        /** @private */
        this.numIndices = (cfg.indices) ? cfg.indices.length / 3 : 0;

        // Vertex arrays
        this._colors = [];
        this._pickColors = [];
        this._offsets = [];

        // Modeling matrix per instance, array for each column
        this._modelMatrixCol0 = [];
        this._modelMatrixCol1 = [];
        this._modelMatrixCol2 = [];

        // Modeling normal matrix per instance, array for each column
        this._modelNormalMatrixCol0 = [];
        this._modelNormalMatrixCol1 = [];
        this._modelNormalMatrixCol2 = [];

        this._portions = [];

        if (cfg.rtcCenter) {
            this._state.rtcCenter = math.vec3(cfg.rtcCenter);
        }

        this._finalized = false;

        /**
         * The axis-aligned World-space boundary of this InstancingLayer's positions.
         * @type {*|Float64Array}
         */
        this.aabb = math.collapseAABB3();
    }

    /**
     * Creates a new portion within this InstancingLayer, returns the new portion ID.
     *
     * The portion will instance this InstancingLayer's geometry.
     *
     * Gives the portion the specified color and matrix.
     *
     * @param rgbaInt Quantized RGBA color
     * @param opacity Opacity [0..255]
     * @param meshMatrix Flat float 4x4 matrix
     * @param [worldMatrix] Flat float 4x4 matrix
     * @param worldAABB Flat float AABB
     * @param pickColor Quantized pick color
     * @returns {number} Portion ID
     */
    createPortion(rgbaInt, opacity, meshMatrix, worldMatrix, worldAABB, pickColor) {

        if (this._finalized) {
            throw "Already finalized";
        }

        // TODO: find AABB for portion by transforming the geometry local AABB by the given meshMatrix?

        const r = rgbaInt[0]; // Color is pre-quantized by PerformanceModel
        const g = rgbaInt[1];
        const b = rgbaInt[2];
        const a = rgbaInt[3];

        this._colors.push(r);
        this._colors.push(g);
        this._colors.push(b);
        this._colors.push(opacity);

        if (this.model.scene.entityOffsetsEnabled) {
            this._offsets.push(0);
            this._offsets.push(0);
            this._offsets.push(0);
        }

        this._modelMatrixCol0.push(meshMatrix[0]);
        this._modelMatrixCol0.push(meshMatrix[4]);
        this._modelMatrixCol0.push(meshMatrix[8]);
        this._modelMatrixCol0.push(meshMatrix[12]);

        this._modelMatrixCol1.push(meshMatrix[1]);
        this._modelMatrixCol1.push(meshMatrix[5]);
        this._modelMatrixCol1.push(meshMatrix[9]);
        this._modelMatrixCol1.push(meshMatrix[13]);

        this._modelMatrixCol2.push(meshMatrix[2]);
        this._modelMatrixCol2.push(meshMatrix[6]);
        this._modelMatrixCol2.push(meshMatrix[10]);
        this._modelMatrixCol2.push(meshMatrix[14]);

        // Note: order of inverse and transpose doesn't matter

        let transposedMat = math.transposeMat4(meshMatrix, math.mat4()); // TODO: Use cached matrix
        let normalMatrix = math.inverseMat4(transposedMat);

        this._modelNormalMatrixCol0.push(normalMatrix[0]);
        this._modelNormalMatrixCol0.push(normalMatrix[4]);
        this._modelNormalMatrixCol0.push(normalMatrix[8]);
        this._modelNormalMatrixCol0.push(normalMatrix[12]);

        this._modelNormalMatrixCol1.push(normalMatrix[1]);
        this._modelNormalMatrixCol1.push(normalMatrix[5]);
        this._modelNormalMatrixCol1.push(normalMatrix[9]);
        this._modelNormalMatrixCol1.push(normalMatrix[13]);

        this._modelNormalMatrixCol2.push(normalMatrix[2]);
        this._modelNormalMatrixCol2.push(normalMatrix[6]);
        this._modelNormalMatrixCol2.push(normalMatrix[10]);
        this._modelNormalMatrixCol2.push(normalMatrix[14]);

        // Per-vertex pick colors

        this._pickColors.push(pickColor[0]);
        this._pickColors.push(pickColor[1]);
        this._pickColors.push(pickColor[2]);
        this._pickColors.push(pickColor[3]);

        // Expand AABB

        math.collapseAABB3(worldAABB);
        const obb = this._state.obb;
        const lenPositions = obb.length;
        for (let i = 0; i < lenPositions; i += 4) {
            tempVec4a[0] = obb[i + 0];
            tempVec4a[1] = obb[i + 1];
            tempVec4a[2] = obb[i + 2];
            math.transformPoint4(meshMatrix, tempVec4a, tempVec4b);
            if (worldMatrix) {
                math.transformPoint4(worldMatrix, tempVec4b, tempVec4c);
                math.expandAABB3Point3(worldAABB, tempVec4c);
            } else {
                math.expandAABB3Point3(worldAABB, tempVec4b);
            }
        }

        if (this._state.rtcCenter) {
            const rtcCenter = this._state.rtcCenter;
            worldAABB[0] += rtcCenter[0];
            worldAABB[1] += rtcCenter[1];
            worldAABB[2] += rtcCenter[2];
            worldAABB[3] += rtcCenter[0];
            worldAABB[4] += rtcCenter[1];
            worldAABB[5] += rtcCenter[2];
        }

        math.expandAABB3(this.aabb, worldAABB);

        this._state.numInstances++;

        const portionId = this._portions.length;
        this._portions.push({});

        this._numPortions++;
        this.model.numPortions++;

        return portionId;
    }

    finalize() {
        if (this._finalized) {
            throw "Already finalized";
        }
        const gl = this.model.scene.canvas.gl;
        const colorsLength = this._colors.length;
        const flagsLength = colorsLength;
        if (colorsLength > 0) {
            let notNormalized = false;
            this._state.colorsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Uint8Array(this._colors), this._colors.length, 4, gl.DYNAMIC_DRAW, notNormalized);
            this._colors = []; // Release memory
        }
        if (flagsLength > 0) {
            // Because we only build flags arrays here, 
            // get their length from the colors array
            let notNormalized = false;
            let normalized = true;
            this._state.flagsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Uint8Array(flagsLength), flagsLength, 4, gl.DYNAMIC_DRAW, notNormalized);
            this._state.flags2Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Uint8Array(flagsLength), flagsLength, 4, gl.DYNAMIC_DRAW, normalized);
        }
        if (this.model.scene.entityOffsetsEnabled) {
            if (this._offsets.length > 0) {
                const notNormalized = false;
                this._state.offsetsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._offsets), this._offsets.length, 3, gl.DYNAMIC_DRAW, notNormalized);
                this._offsets = []; // Release memory
            }
        }
        if (this._modelMatrixCol0.length > 0) {

            const normalized = false;

            this._state.modelMatrixCol0Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelMatrixCol0), this._modelMatrixCol0.length, 4, gl.STATIC_DRAW, normalized);
            this._state.modelMatrixCol1Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelMatrixCol1), this._modelMatrixCol1.length, 4, gl.STATIC_DRAW, normalized);
            this._state.modelMatrixCol2Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelMatrixCol2), this._modelMatrixCol2.length, 4, gl.STATIC_DRAW, normalized);
            this._modelMatrixCol0 = [];
            this._modelMatrixCol1 = [];
            this._modelMatrixCol2 = [];

            this._state.modelNormalMatrixCol0Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelNormalMatrixCol0), this._modelNormalMatrixCol0.length, 4, gl.STATIC_DRAW, normalized);
            this._state.modelNormalMatrixCol1Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelNormalMatrixCol1), this._modelNormalMatrixCol1.length, 4, gl.STATIC_DRAW, normalized);
            this._state.modelNormalMatrixCol2Buf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Float32Array(this._modelNormalMatrixCol2), this._modelNormalMatrixCol2.length, 4, gl.STATIC_DRAW, normalized);
            this._modelNormalMatrixCol0 = [];
            this._modelNormalMatrixCol1 = [];
            this._modelNormalMatrixCol2 = [];
        }
        if (this._pickColors.length > 0) {
            const normalized = false;
            this._state.pickColorsBuf = new ArrayBuf(gl, gl.ARRAY_BUFFER, new Uint8Array(this._pickColors), this._pickColors.length, 4, gl.STATIC_DRAW, normalized);
            this._pickColors = []; // Release memory
        }
        this._finalized = true;
    }

    // The following setters are called by PerformanceMesh, in turn called by PerformanceNode, only after the layer is finalized.
    // It's important that these are called after finalize() in order to maintain integrity of counts like _numVisibleLayerPortions etc.

    initFlags(portionId, flags, meshTransparent) {
        if (flags & ENTITY_FLAGS.VISIBLE) {
            this._numVisibleLayerPortions++;
            this.model.numVisibleLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.HIGHLIGHTED) {
            this._numHighlightedLayerPortions++;
            this.model.numHighlightedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.XRAYED) {
            this._numXRayedLayerPortions++;
            this.model.numXRayedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.SELECTED) {
            this._numSelectedLayerPortions++;
            this.model.numSelectedLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.CLIPPABLE) {
            this._numClippableLayerPortions++;
            this.model.numClippableLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.EDGES) {
            this._numEdgesLayerPortions++;
            this.model.numEdgesLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.PICKABLE) {
            this._numPickableLayerPortions++;
            this.model.numPickableLayerPortions++;
        }
        if (flags & ENTITY_FLAGS.CULLED) {
            this._numCulledLayerPortions++;
            this.model.numCulledLayerPortions++;
        }
        if (meshTransparent) {
            this._numTransparentLayerPortions++;
            this.model.numTransparentLayerPortions++;
        }
        this._setFlags(portionId, flags, meshTransparent);
        this._setFlags2(portionId, flags);
    }

    setVisible(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.VISIBLE) {
            this._numVisibleLayerPortions++;
            this.model.numVisibleLayerPortions++;
        } else {
            this._numVisibleLayerPortions--;
            this.model.numVisibleLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setHighlighted(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.HIGHLIGHTED) {
            this._numHighlightedLayerPortions++;
            this.model.numHighlightedLayerPortions++;
        } else {
            this._numHighlightedLayerPortions--;
            this.model.numHighlightedLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setXRayed(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.XRAYED) {
            this._numXRayedLayerPortions++;
            this.model.numXRayedLayerPortions++;
        } else {
            this._numXRayedLayerPortions--;
            this.model.numXRayedLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setSelected(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.SELECTED) {
            this._numSelectedLayerPortions++;
            this.model.numSelectedLayerPortions++;
        } else {
            this._numSelectedLayerPortions--;
            this.model.numSelectedLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setEdges(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.EDGES) {
            this._numEdgesLayerPortions++;
            this.model.numEdgesLayerPortions++;
        } else {
            this._numEdgesLayerPortions--;
            this.model.numEdgesLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setClippable(portionId, flags) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.CLIPPABLE) {
            this._numClippableLayerPortions++;
            this.model.numClippableLayerPortions++;
        } else {
            this._numClippableLayerPortions--;
            this.model.numClippableLayerPortions--;
        }
        this._setFlags2(portionId, flags);
    }

    setCollidable(portionId, flags) {
        if (!this._finalized) {
            throw "Not finalized";
        }
    }

    setPickable(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.PICKABLE) {
            this._numPickableLayerPortions++;
            this.model.numPickableLayerPortions++;
        } else {
            this._numPickableLayerPortions--;
            this.model.numPickableLayerPortions--;
        }
        this._setFlags2(portionId, flags, meshTransparent);
    }

    setCulled(portionId, flags, meshTransparent) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (flags & ENTITY_FLAGS.CULLED) {
            this._numCulledLayerPortions++;
            this.model.numCulledLayerPortions++;
        } else {
            this._numCulledLayerPortions--;
            this.model.numCulledLayerPortions--;
        }
        this._setFlags(portionId, flags, meshTransparent);
    }

    setColor(portionId, color) { // RGBA color is normalized as ints
        if (!this._finalized) {
            throw "Not finalized";
        }
        tempUint8Vec4[0] = color[0];
        tempUint8Vec4[1] = color[1];
        tempUint8Vec4[2] = color[2];
        tempUint8Vec4[3] = color[3];
        this._state.colorsBuf.setData(tempUint8Vec4, portionId * 4, 4);
    }

    setTransparent(portionId, flags, transparent) {
        if (transparent) {
            this._numTransparentLayerPortions++;
            this.model.numTransparentLayerPortions++;
        } else {
            this._numTransparentLayerPortions--;
            this.model.numTransparentLayerPortions--;
        }
        this._setFlags(portionId, flags, transparent);
    }

    // setMatrix(portionId, matrix) {
    //
    //     if (!this._finalized) {
    //         throw "Not finalized";
    //     }
    //
    //     var offset = portionId * 4;
    //
    //     tempFloat32Vec4[0] = matrix[0];
    //     tempFloat32Vec4[1] = matrix[4];
    //     tempFloat32Vec4[2] = matrix[8];
    //     tempFloat32Vec4[3] = matrix[12];
    //
    //     this._state.modelMatrixCol0Buf.setData(tempFloat32Vec4, offset, 4);
    //
    //     tempFloat32Vec4[0] = matrix[1];
    //     tempFloat32Vec4[1] = matrix[5];
    //     tempFloat32Vec4[2] = matrix[9];
    //     tempFloat32Vec4[3] = matrix[13];
    //
    //     this._state.modelMatrixCol1Buf.setData(tempFloat32Vec4, offset, 4);
    //
    //     tempFloat32Vec4[0] = matrix[2];
    //     tempFloat32Vec4[1] = matrix[6];
    //     tempFloat32Vec4[2] = matrix[10];
    //     tempFloat32Vec4[3] = matrix[14];
    //
    //     this._state.modelMatrixCol2Buf.setData(tempFloat32Vec4, offset, 4);
    // }

    _setFlags(portionId, flags, meshTransparent) {

        if (!this._finalized) {
            throw "Not finalized";
        }

        const visible = !!(flags & ENTITY_FLAGS.VISIBLE);
        const xrayed = !!(flags & ENTITY_FLAGS.XRAYED);
        const highlighted = !!(flags & ENTITY_FLAGS.HIGHLIGHTED);
        const selected = !!(flags & ENTITY_FLAGS.SELECTED);
        const edges = !!(flags & ENTITY_FLAGS.EDGES);
        const pickable = !!(flags & ENTITY_FLAGS.PICKABLE);
        const culled = !!(flags & ENTITY_FLAGS.CULLED);

        // Normal fill

        let f0;
        if (!visible || culled || xrayed) {
            f0 = RENDER_PASSES.NOT_RENDERED;
        } else {
            if (meshTransparent) {
                f0 = RENDER_PASSES.TRANSPARENT_FILL;
            } else {
                f0 = RENDER_PASSES.OPAQUE_FILL;
            }
        }

        // Emphasis fill

        let f1;
        if (!visible || culled) {
            f1 = RENDER_PASSES.NOT_RENDERED;
        } else if (selected) {
            f1 = RENDER_PASSES.SELECTED_FILL;
        } else if (highlighted) {
            f1 = RENDER_PASSES.HIGHLIGHTED_FILL;
        } else if (xrayed) {
            f1 = RENDER_PASSES.XRAYED_FILL;
        } else {
            f1 = RENDER_PASSES.NOT_RENDERED;
        }

        // Edges

        let f2 = 0;
        if (!visible || culled) {
            f2 = RENDER_PASSES.NOT_RENDERED;
        } else if (selected) {
            f2 = RENDER_PASSES.SELECTED_EDGES;
        } else if (highlighted) {
            f2 = RENDER_PASSES.HIGHLIGHTED_EDGES;
        } else if (xrayed) {
            f2 = RENDER_PASSES.XRAYED_EDGES;
        } else if (edges) {
            if (meshTransparent) {
                f2 = RENDER_PASSES.TRANSPARENT_EDGES;
            } else {
                f2 = RENDER_PASSES.OPAQUE_EDGES;
            }
        } else {
            f2 = RENDER_PASSES.NOT_RENDERED;
        }

        // Pick

        let f3 = (visible && !culled && pickable) ? RENDER_PASSES.PICK : RENDER_PASSES.NOT_RENDERED;

        tempUint8Vec4[0] = f0; // x - normal fill
        tempUint8Vec4[1] = f1; // y - emphasis fill
        tempUint8Vec4[2] = f2; // z - edges
        tempUint8Vec4[3] = f3; // w - pick

        this._state.flagsBuf.setData(tempUint8Vec4, portionId * 4, 4);
    }

    _setFlags2(portionId, flags) {

        if (!this._finalized) {
            throw "Not finalized";
        }

        const clippable = !!(flags & ENTITY_FLAGS.CLIPPABLE) ? 255 : 0;
        tempUint8Vec4[0] = clippable;

        this._state.flags2Buf.setData(tempUint8Vec4, portionId * 4, 4);
    }

    setOffset(portionId, offset) {
        if (!this._finalized) {
            throw "Not finalized";
        }
        if (!this.model.scene.entityOffsetsEnabled) {
            this.model.error("Entity#offset not enabled for this Viewer"); // See Viewer entityOffsetsEnabled
            return;
        }
        tempVec3fa[0] = offset[0];
        tempVec3fa[1] = offset[1];
        tempVec3fa[2] = offset[2];
        this._state.offsetsBuf.setData(tempVec3fa, portionId * 3, 3);
    }

    // ---------------------- NORMAL RENDERING -----------------------------------

    drawNormalOpaqueFill(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (frameCtx.withSAO) {
            if (this._instancingRenderers.drawRendererWithSAO) {
                this._instancingRenderers.drawRendererWithSAO.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL);
            }
        } else {
            if (this._instancingRenderers.drawRenderer) {
                this._instancingRenderers.drawRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL);
            }
        }
    }

    drawNormalTransparentFill(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === 0 || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (this._instancingRenderers.drawRenderer) {
            this._instancingRenderers.drawRenderer.drawLayer(frameCtx, this, RENDER_PASSES.TRANSPARENT_FILL);
        }
    }

    // ---------------------- RENDERING SAO POST EFFECT TARGETS --------------

    drawDepth(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (this._instancingRenderers.depthRenderer) {
            this._instancingRenderers.depthRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL); // Assume whatever post-effect uses depth (eg SAO) does not apply to transparent objects
        }
    }

    drawNormals(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numTransparentLayerPortions === this._numPortions || this._numXRayedLayerPortions === this._numPortions) {
            return;
        }
        if (this._instancingRenderers.normalsRenderer) {
            this._instancingRenderers.normalsRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL); // Assume whatever post-effect uses normals (eg SAO) does not apply to transparent objects
        }
    }

    // ---------------------- EMPHASIS RENDERING -----------------------------------

    drawXRayedFill(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numXRayedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.fillRenderer) {
            this._instancingRenderers.fillRenderer.drawLayer(frameCtx, this, RENDER_PASSES.XRAYED_FILL);
        }
    }

    drawHighlightedFill(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numHighlightedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.fillRenderer) {
            this._instancingRenderers.fillRenderer.drawLayer(frameCtx, this, RENDER_PASSES.HIGHLIGHTED_FILL);
        }
    }

    drawSelectedFill(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numSelectedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.fillRenderer) {
            this._instancingRenderers.fillRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SELECTED_FILL);
        }
    }

    // ---------------------- EDGES RENDERING -----------------------------------

    drawNormalOpaqueEdges(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numEdgesLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.edgesRenderer) {
            this._instancingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_EDGES);
        }
    }

    drawNormalTransparentEdges(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numEdgesLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.edgesRenderer) {
            this._instancingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.TRANSPARENT_EDGES);
        }
    }

    drawXRayedEdges(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numXRayedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.edgesRenderer) {
            this._instancingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.XRAYED_EDGES);
        }
    }

    drawHighlightedEdges(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numHighlightedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.edgesRenderer) {
            this._instancingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.HIGHLIGHTED_EDGES);
        }
    }

    drawSelectedEdges(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0 || this._numSelectedLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.edgesRenderer) {
            this._instancingRenderers.edgesRenderer.drawLayer(frameCtx, this, RENDER_PASSES.SELECTED_EDGES);
        }
    }

    // ---------------------- OCCLUSION CULL RENDERING -----------------------------------

    drawOcclusion(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.occlusionRenderer) {
            // Only opaque, filled objects can be occluders
            this._instancingRenderers.occlusionRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL);
        }
    }

    // ---------------------- SHADOW BUFFER RENDERING -----------------------------------

    drawShadow(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.shadowRenderer) {
            this._instancingRenderers.shadowRenderer.drawLayer(frameCtx, this, RENDER_PASSES.OPAQUE_FILL);
        }
    }

    //---- PICKING ----------------------------------------------------------------------------------------------------

    drawPickMesh(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.pickMeshRenderer) {
            this._instancingRenderers.pickMeshRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        }
    }

    drawPickDepths(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.pickDepthRenderer) {
            this._instancingRenderers.pickDepthRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        }
    }

    drawPickNormals(frameCtx) {
        if (this._numCulledLayerPortions === this._numPortions || this._numVisibleLayerPortions === 0) {
            return;
        }
        if (this._instancingRenderers.pickNormalsRenderer) {
            this._instancingRenderers.pickNormalsRenderer.drawLayer(frameCtx, this, RENDER_PASSES.PICK);
        }
    }


    destroy() {
        const state = this._state;
        if (state.positionsBuf) {
            state.positionsBuf.destroy();
            state.positionsBuf = null;
        }
        if (state.normalsBuf) {
            state.normalsBuf.destroy();
            state.normalsBuf = null;
        }
        if (state.colorsBuf) {
            state.colorsBuf.destroy();
            state.colorsBuf = null;
        }
        if (state.flagsBuf) {
            state.flagsBuf.destroy();
            state.flagsBuf = null;
        }
        if (state.flags2Buf) {
            state.flags2Buf.destroy();
            state.flags2Buf = null;
        }
        if (state.offsetsBuf) {
            state.offsetsBuf.destroy();
            state.offsetsBuf = null;
        }
        if (state.modelMatrixCol0Buf) {
            state.modelMatrixCol0Buf.destroy();
            state.modelMatrixCol0Buf = null;
        }
        if (state.modelMatrixCol1Buf) {
            state.modelMatrixCol1Buf.destroy();
            state.modelMatrixCol1Buf = null;
        }
        if (state.modelMatrixCol2Buf) {
            state.modelMatrixCol2Buf.destroy();
            state.modelMatrixCol2Buf = null;
        }
        if (state.modelNormalMatrixCol0Buf) {
            state.modelNormalMatrixCol0Buf.destroy();
            state.modelNormalMatrixCol0Buf = null;
        }
        if (state.modelNormalMatrixCol1Buf) {
            state.modelNormalMatrixCol1Buf.destroy();
            state.modelNormalMatrixCol1Buf = null;
        }
        if (state.modelNormalMatrixCol2Buf) {
            state.modelNormalMatrixCol2Buf.destroy();
            state.modelNormalMatrixCol2Buf = null;
        }
        if (state.indicesBuf) {
            state.indicesBuf.destroy();
            state.indicessBuf = null;
        }
        if (state.edgeIndicesBuf) {
            state.edgeIndicesBuf.destroy();
            state.edgeIndicessBuf = null;
        }
        if (state.pickColorsBuf) {
            state.pickColorsBuf.destroy();
            state.pickColorsBuf = null;
        }
        state.destroy();
    }
}

const quantizePositions = (function () { // http://cg.postech.ac.kr/research/mesh_comp_mobile/mesh_comp_mobile_conference.pdf
    const translate = math.mat4();
    const scale = math.mat4();
    const scalar = math.vec3();
    return function (positions, lenPositions, aabb, quantizedPositions, positionsDecodeMatrix) {

        const xmin = aabb[0];
        const ymin = aabb[1];
        const zmin = aabb[2];
        const xmax = aabb[3];
        const ymax = aabb[4];
        const zmax = aabb[5];
        const xwid = aabb[3] - xmin;
        const ywid = aabb[4] - ymin;
        const zwid = aabb[5] - zmin;
        const xMultiplier = xmax !== xmin ? 65535 / (xmax - xmin) : 0;
        const yMultiplier = ymax !== ymin ? 65535 / (ymax - ymin) : 0;
        const zMultiplier = zmax !== zmin ? 65535 / (zmax - zmin) : 0;

        for (let i = 0; i < lenPositions; i += 3) {
            quantizedPositions[i + 0] = Math.floor((positions[i + 0] - xmin) * xMultiplier);
            quantizedPositions[i + 1] = Math.floor((positions[i + 1] - ymin) * yMultiplier);
            quantizedPositions[i + 2] = Math.floor((positions[i + 2] - zmin) * zMultiplier);
        }
        math.identityMat4(translate);
        math.translationMat4v(aabb, translate);
        math.identityMat4(scale);
        scalar[0] = xwid / 65535;
        scalar[1] = ywid / 65535;
        scalar[2] = zwid / 65535;
        math.scalingMat4v(scalar, scale);
        math.mulMat4(translate, scale, positionsDecodeMatrix);
    };
})();

function octEncodeNormals(normals, lenNormals, compressedNormals, lenCompressedNormals) { // http://jcgt.org/published/0003/02/01/
    let oct, dec, best, currentCos, bestCos;
    for (let i = 0; i < lenNormals; i += 3) {
        // Test various combinations of ceil and floor to minimize rounding errors
        best = oct = octEncodeVec3(normals, i, "floor", "floor");
        dec = octDecodeVec2(oct);
        currentCos = bestCos = dot(normals, i, dec);
        oct = octEncodeVec3(normals, i, "ceil", "floor");
        dec = octDecodeVec2(oct);
        currentCos = dot(normals, i, dec);
        if (currentCos > bestCos) {
            best = oct;
            bestCos = currentCos;
        }
        oct = octEncodeVec3(normals, i, "floor", "ceil");
        dec = octDecodeVec2(oct);
        currentCos = dot(normals, i, dec);
        if (currentCos > bestCos) {
            best = oct;
            bestCos = currentCos;
        }
        oct = octEncodeVec3(normals, i, "ceil", "ceil");
        dec = octDecodeVec2(oct);
        currentCos = dot(normals, i, dec);
        if (currentCos > bestCos) {
            best = oct;
            bestCos = currentCos;
        }
        compressedNormals[lenCompressedNormals + i + 0] = best[0];
        compressedNormals[lenCompressedNormals + i + 1] = best[1];
        compressedNormals[lenCompressedNormals + i + 2] = 0.0; // Unused
    }
    lenCompressedNormals += lenNormals;
    return lenCompressedNormals;
}

function octEncodeVec3(array, i, xfunc, yfunc) { // Oct-encode single normal vector in 2 bytes
    let x = array[i] / (Math.abs(array[i]) + Math.abs(array[i + 1]) + Math.abs(array[i + 2]));
    let y = array[i + 1] / (Math.abs(array[i]) + Math.abs(array[i + 1]) + Math.abs(array[i + 2]));
    if (array[i + 2] < 0) {
        let tempx = x;
        let tempy = y;
        tempx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
        tempy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        x = tempx;
        y = tempy;
    }
    return new Int8Array([
        Math[xfunc](x * 127.5 + (x < 0 ? -1 : 0)),
        Math[yfunc](y * 127.5 + (y < 0 ? -1 : 0))
    ]);
}

function octDecodeVec2(oct) { // Decode an oct-encoded normal
    let x = oct[0];
    let y = oct[1];
    x /= x < 0 ? 127 : 128;
    y /= y < 0 ? 127 : 128;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
        x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
        y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    }
    const length = Math.sqrt(x * x + y * y + z * z);
    return [
        x / length,
        y / length,
        z / length
    ];
}

function dot(array, i, vec3) { // Dot product of a normal in an array against a candidate decoding
    return array[i] * vec3[0] + array[i + 1] * vec3[1] + array[i + 2] * vec3[2];
}

export {InstancingLayer};