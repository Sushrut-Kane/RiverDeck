/*
 * shared-node.js — reuse the browser modules on the server, unchanged.
 *
 * deck.js, evaluator.js and ai.js are written as plain browser globals (no
 * module.exports). Rather than modify them, we run all three in one shared VM
 * context — exactly like test-harness.js does — and re-export the functions
 * the server engine needs. This keeps those three files at zero diff and means
 * the AI, the shuffle and the hand evaluator are byte-for-byte identical online
 * and offline.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {
  crypto: require('crypto').webcrypto, // deck.js uses crypto.getRandomValues
  Math,
  console
};
vm.createContext(ctx);

for (const file of ['deck.js', 'evaluator.js', 'ai.js']) {
  const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
}

module.exports = {
  // deck.js
  freshShuffledDeck: ctx.freshShuffledDeck,
  secureRandomInt: ctx.secureRandomInt,
  cardToString: ctx.cardToString,
  rankLabel: ctx.rankLabel,
  suitSymbol: ctx.suitSymbol,
  isRedSuit: ctx.isRedSuit,
  // evaluator.js
  evaluate7: ctx.evaluate7,
  compareScores: ctx.compareScores,
  handName: ctx.handName,
  // ai.js
  makePersonality: ctx.makePersonality,
  decideAction: ctx.decideAction,
  drawStrength: ctx.drawStrength,
  scaryBoardCard: ctx.scaryBoardCard,
  preflopPositionBias: ctx.preflopPositionBias
};
