// The outline programs beside the lawn outline, each behind its own gate (owner 2026-10-26, decision D4-A: Tree & Shrub,
// Pest Control, then Mosquito). The outline routes build, store, regenerate and send them by the packet's service line;
// the Estimates list offers each one on an estimate that has its line. A packet with any other service line is a lawn
// outline. Each entry reads its module at call time, so a test that mocks a module is followed.
const treeShrub = require('./tree-shrub-service-outline');
const pest = require('./pest-service-outline');
const mosquito = require('./mosquito-service-outline');

const OUTLINE_PROGRAMS = Object.freeze({
  tree_shrub: Object.freeze({
    build: (args) => treeShrub.buildTreeShrubOutline(args),
    live: () => treeShrub.treeShrubOutlineLive(),
    // An inferEstimateServiceLines line (and the estimate's monthly total) that offers this outline on the Estimates list.
    offeredOn: (line) => line.key === 'tree_shrub',
    contentLibraryVersion: () => treeShrub.TS_CONTENT_LIBRARY_VERSION,
    protocolVersion: () => treeShrub.treeShrubProtocolVersion(),
    listKeys: Object.freeze({ available: 'treeShrubOutlineAvailable', outline: 'treeShrubServiceOutline' }),
    offError: 'Tree & Shrub outlines are not turned on.',
    send: Object.freeze({ program: 'tree and shrub', title: 'Your Waves Tree & Shrub Program Overview', messageType: 'tree_shrub_service_outline' }),
  }),
  pest_control: Object.freeze({
    build: (args) => pest.buildPestOutline(args),
    live: () => pest.pestOutlineLive(),
    // A recurring pest plan: a one-time pest job gets no program overview. A residential estimate without engine lines
    // infers its lines from text, which marks a one-time job "monthly", so the estimate's monthly total decides too.
    offeredOn: (line, { monthlyTotal = 0 } = {}) => line.key === 'pest' && line.amountBasis !== 'one_time' && monthlyTotal > 0,
    contentLibraryVersion: () => pest.PEST_CONTENT_LIBRARY_VERSION,
    protocolVersion: () => pest.pestProtocolVersion(),
    listKeys: Object.freeze({ available: 'pestOutlineAvailable', outline: 'pestServiceOutline' }),
    offError: 'Pest Control outlines are not turned on.',
    send: Object.freeze({ program: 'pest control', title: 'Your Waves Pest Control Program Overview', messageType: 'pest_service_outline' }),
  }),
  mosquito: Object.freeze({
    build: (args) => mosquito.buildMosquitoOutline(args),
    live: () => mosquito.mosquitoOutlineLive(),
    // A recurring mosquito program: the stored estimate holds an exact `mosquito` recurring row (one-time, misting and
    // commercial mosquito rows are other keys). The estimate's service-line text cannot tell them apart, so the stored
    // rows decide (mosquito-service-outline.js); the Estimates list passes the estimate's data.
    offeredOn: (line, { estimateData } = {}) => line.key === 'mosquito' && !!mosquito.mosquitoProgramRow(estimateData),
    contentLibraryVersion: () => mosquito.MOSQUITO_CONTENT_LIBRARY_VERSION,
    protocolVersion: () => mosquito.mosquitoProtocolVersion(),
    listKeys: Object.freeze({ available: 'mosquitoOutlineAvailable', outline: 'mosquitoServiceOutline' }),
    offError: 'Mosquito outlines are not turned on.',
    send: Object.freeze({ program: 'mosquito', title: 'Your Waves Mosquito Program Overview', messageType: 'mosquito_service_outline' }),
  }),
});

function outlineProgram(serviceLine) {
  return Object.prototype.hasOwnProperty.call(OUTLINE_PROGRAMS, serviceLine) ? OUTLINE_PROGRAMS[serviceLine] : null;
}

module.exports = { OUTLINE_PROGRAMS, outlineProgram };
