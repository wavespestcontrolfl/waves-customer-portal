'use strict';

const CASES = {};
for (const name of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10']) Object.assign(CASES, require(`./${name}`).CASES);
module.exports = { CASES };
