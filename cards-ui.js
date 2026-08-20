/*
 * cards-ui.js — how cards look as they hit the table.
 *
 * Shared by the offline game (game.js) and the online table (online.js) so the
 * dealing animations behave identically in both. Two effects:
 *   - deal-in: a card slides/tilts into place, like it was pitched from the deck.
 *   - cover/uncover: the river card lands face-down, holds a beat for suspense,
 *     then flips face-up. Flop/turn just deal in briskly (kept deliberately
 *     understated).
 *
 * Both renderers are incremental: a slot only animates when its card actually
 * changes, so the frequent full re-renders during a hand don't restart anims.
 *
 * Depends on deck.js globals: rankLabel, suitSymbol, isRedSuit.
 */
const CardsUI = (function () {
  function cardKey(card) {
    return card ? card.rank + '-' + card.suit : 'empty';
  }

  function faceUpHTML(card) {
    const red = isRedSuit(card.suit) ? ' red' : '';
    return `<div class="card${red}">` +
      `<span class="corner"><span class="rank">${rankLabel(card.rank)}</span><span class="suit">${suitSymbol(card.suit)}</span></span>` +
      `<span class="pip">${suitSymbol(card.suit)}</span>` +
      `</div>`;
  }

  // String form (used for statically-rendered opponent seats).
  function cardHTML(card, faceDown) {
    if (faceDown || !card) return '<div class="card back"><span class="card-logo">\u2663</span></div>';
    return faceUpHTML(card);
  }

  function elFromHTML(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.firstElementChild;
  }

  function cardEl(card) { return elFromHTML(faceUpHTML(card)); }
  function backEl() { return elFromHTML(cardHTML(null, true)); }
  function placeholderEl() {
    const el = document.createElement('div');
    el.className = 'card placeholder';
    el.dataset.key = 'empty';
    return el;
  }

  // Make `container` hold exactly `n` slot elements (placeholders to start).
  function ensureSlots(container, n) {
    while (container.children.length < n) container.appendChild(placeholderEl());
    while (container.children.length > n) container.removeChild(container.lastElementChild);
  }

  function placeCommunityCard(parent, index, card, suspense) {
    const key = cardKey(card);
    if (!suspense) {
      const face = cardEl(card);
      face.classList.add('dealing');
      face.style.animationDelay = (index * 70) + 'ms';
      face.dataset.key = key;
      parent.replaceChild(face, parent.children[index]);
      return;
    }
    // River: deal face-down, hold, then flip up.
    const back = backEl();
    back.classList.add('dealing');
    back.dataset.key = key; // claim the slot now so re-renders don't retrigger
    parent.replaceChild(back, parent.children[index]);
    setTimeout(() => {
      if (parent.children[index] !== back) return;
      back.classList.remove('dealing');
      back.classList.add('flip-out', 'suspense');
      setTimeout(() => {
        if (parent.children[index] !== back) return;
        const face = cardEl(card);
        face.classList.add('flip-in', 'suspense');
        face.dataset.key = key;
        parent.replaceChild(face, back);
      }, 300);
    }, 650);
  }

  // Render 5 community slots, animating only newly dealt cards.
  function syncBoard(container, community) {
    ensureSlots(container, 5);
    for (let i = 0; i < 5; i++) {
      const slot = container.children[i];
      const card = community[i] || null;
      const key = cardKey(card);
      if (slot.dataset.key === key) continue;
      const wasEmpty = !slot.dataset.key || slot.dataset.key === 'empty';
      if (!card) {
        container.replaceChild(placeholderEl(), slot);
      } else if (wasEmpty) {
        placeCommunityCard(container, i, card, i === 4);
      } else {
        const face = cardEl(card);
        face.dataset.key = key;
        container.replaceChild(face, slot);
      }
    }
  }

  // Render exactly two hole-card slots. `handKey` (the hand number) makes a new
  // deal animate even when the face-down back looks the same as last hand.
  function syncHole(container, cards, opts) {
    opts = opts || {};
    const faceDown = !!opts.faceDown;
    const handKey = String(opts.handKey == null ? '' : opts.handKey);
    ensureSlots(container, 2);
    for (let i = 0; i < 2; i++) {
      const slot = container.children[i];
      const card = cards && cards[i];
      const base = faceDown ? 'back' : cardKey(card);
      const slotKey = base + '#' + handKey;
      if (slot.dataset.key === slotKey) continue;
      const freshHand = slot.dataset.hand !== handKey;
      let el;
      if (faceDown) el = backEl();
      else if (card) el = cardEl(card);
      else el = placeholderEl();
      if (freshHand && (faceDown || card)) el.classList.add('dealing');
      el.dataset.key = slotKey;
      el.dataset.hand = handKey;
      container.replaceChild(el, slot);
    }
  }

  return { cardHTML, syncBoard, syncHole, cardEl };
})();

if (typeof window !== 'undefined') window.CardsUI = CardsUI;
