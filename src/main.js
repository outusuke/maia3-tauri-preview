const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const STANDARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const GRADE_BADGE_ICON = {
  brilliant: "img/classifications/brilliant.png",
  onlymove: "img/classifications/critical.png",
  best: "img/classifications/best.png",
  good: "img/classifications/okay.png",
  inaccuracy: "img/classifications/inaccuracy.png",
  mistake: "img/classifications/mistake.png",
  blunder: "img/classifications/blunder.png",
};

function pieceImageSrc(piece) {
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `img/chesspieces/wikipedia/${color}${piece.toUpperCase()}.png`;
}

for (const p of "KQRBNPkqrbnp") {
  const img = new Image();
  img.src = pieceImageSrc(p);
  if (img.decode) img.decode().catch(() => {});
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function isPieceOfColor(piece, color) {
  if (!piece) return false;
  return color === "white" ? piece === piece.toUpperCase() : piece === piece.toLowerCase();
}

// Pointer events instead of HTML5 DnD: WebKitGTK's is flaky, and the click after a drag used to land on the destination square.
let activeDrag = null;

function beginPointerDrag(pointerEvent, spec) {
  const { boardEl, fromSq } = spec;
  const startX = pointerEvent.clientX;
  const startY = pointerEvent.clientY;
  let size = 52;
  let engaged = false;
  let ghost = null;
  let overEl = null;

  function applyDragClasses() {
    if (!boardEl || !fromSq) return;
    const src = boardEl.querySelector(`.square[data-square="${fromSq}"]`);
    if (src) src.classList.add("dragging");
    if (overEl && overEl.dataset && overEl.dataset.square && !overEl.isConnected) {
      overEl = boardEl.querySelector(`.square[data-square="${overEl.dataset.square}"]`);
    }
    if (overEl) overEl.classList.add("drag-over");
  }

  function setOver(next) {
    if (next === overEl) return;
    if (overEl) overEl.classList.remove("drag-over");
    if (next) next.classList.add("drag-over");
    overEl = next;
  }

  function elementUnder(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY);
    if (!under || !under.closest) return null;
    return under.closest(".square[data-square]") || under.closest(".tray");
  }

  function onMove(ev) {
    if (!spec.ghostSrc) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!engaged) {
      if (Math.hypot(dx, dy) < 4) return;
      engaged = true;
      const anySquare = boardEl && boardEl.querySelector(".square");
      if (anySquare) size = anySquare.getBoundingClientRect().width * 0.95;
      document.body.classList.add("is-dragging");
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      ghost = document.createElement("img");
      ghost.src = spec.ghostSrc;
      ghost.draggable = false;
      ghost.className = "piece drag-ghost";
      ghost.style.width = ghost.style.height = size + "px";
      document.body.appendChild(ghost);
      activeDrag = { boardEl, refresh: applyDragClasses };
      applyDragClasses();
    }
    ev.preventDefault();
    ghost.style.left = (ev.clientX - size / 2) + "px";
    ghost.style.top = (ev.clientY - size / 2) + "px";
    setOver(elementUnder(ev.clientX, ev.clientY));
  }

  function cleanup() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    if (boardEl) boardEl.querySelectorAll(".dragging, .drag-over").forEach((n) => n.classList.remove("dragging", "drag-over"));
    if (overEl) overEl.classList.remove("drag-over");
    if (ghost) ghost.remove();
    document.body.classList.remove("is-dragging");
    if (activeDrag && activeDrag.boardEl === boardEl) activeDrag = null;
  }

  function onUp(ev) {
    const wasEngaged = engaged;
    const under = elementUnder(ev.clientX, ev.clientY);
    const target = under;
    cleanup();
    if (!wasEngaged) {
      if (spec.onClick && under && under.dataset && under.dataset.square === fromSq) spec.onClick(fromSq);
      return;
    }
    if (!spec.onDrop) return;
    if (target && target.classList.contains("square")) spec.onDrop("square", target.dataset.square);
    else if (target && target.classList.contains("tray")) spec.onDrop("tray", target);
    else spec.onDrop(null, null);
  }

  function onCancel() { cleanup(); }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// Right-drag draws an arrow, right-click a circle; Shift = red, Ctrl/Alt = blue, both = yellow.
const BRUSH = {
  green: "#15781b",
  red: "#c33333",
  blue: "#2f6fdc",
  yellow: "#e68f00",
  human: "#9b4fd8",
};

function brushFromEvent(e) {
  const mod = e.ctrlKey || e.metaKey || e.altKey;
  if (mod && e.shiftKey) return "yellow";
  if (mod) return "blue";
  if (e.shiftKey) return "red";
  return "green";
}

function uciToSquares(uci) {
  return uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : null;
}

function squareCenter(sq, flipped) {
  const fi = FILES.indexOf(sq[0]);
  const ri = parseInt(sq[1], 10) - 1;
  return [(flipped ? 7 - fi : fi) + 0.5, (flipped ? ri : 7 - ri) + 0.5];
}

function squareFromPoint(boardEl, clientX, clientY) {
  const r = boardEl.getBoundingClientRect();
  const w = boardEl.clientWidth, h = boardEl.clientHeight;
  if (!w || !h) return null;
  const x = (clientX - r.left - boardEl.clientLeft) / w * 8;
  const y = (clientY - r.top - boardEl.clientTop) / h * 8;
  if (x < 0 || y < 0 || x >= 8 || y >= 8) return null;
  const col = Math.floor(x), row = Math.floor(y);
  const flipped = !!boardEl._flipped;
  return FILES[flipped ? 7 - col : col] + ((flipped ? row : 7 - row) + 1);
}

function drawArrowShape(svg, shape, flipped) {
  const [x1, y1] = squareCenter(shape.from, flipped);
  const color = BRUSH[shape.brush] || shape.brush || BRUSH.green;
  const opacity = shape.opacity !== undefined ? shape.opacity : 0.8;

  if (shape.from === shape.to) {
    svgEl("circle", {
      cx: x1, cy: y1, r: 0.45, fill: "none", stroke: color, "stroke-width": 0.08, opacity,
    }, svg);
    return;
  }

  const [x2, y2] = squareCenter(shape.to, flipped);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const HEAD_LEN = 0.44, HEAD_HALF = 0.3, LINE_W = 0.17, MARGIN = 0.1, TAIL = 0.12;

  const tipX = x2 - ux * MARGIN, tipY = y2 - uy * MARGIN;
  const baseX = tipX - ux * HEAD_LEN, baseY = tipY - uy * HEAD_LEN;
  // group opacity so the shaft/head overlap doesn't show a darker seam
  const g = svgEl("g", { opacity }, svg);
  svgEl("line", {
    x1: x1 + ux * TAIL, y1: y1 + uy * TAIL,
    x2: baseX + ux * 0.03, y2: baseY + uy * 0.03,
    stroke: color, "stroke-width": LINE_W, "stroke-linecap": "butt",
  }, g);
  const px = -uy, py = ux;
  svgEl("polygon", {
    points: [
      `${tipX},${tipY}`,
      `${baseX + px * HEAD_HALF},${baseY + py * HEAD_HALF}`,
      `${baseX - px * HEAD_HALF},${baseY - py * HEAD_HALF}`,
    ].join(" "),
    fill: color,
  }, g);
}

function renderArrowOverlay(el) {
  let svg = el.querySelector(":scope > svg.board-arrows");
  if (!svg) {
    svg = svgEl("svg", { class: "board-arrows", viewBox: "0 0 8 8", preserveAspectRatio: "none" });
    el.appendChild(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const flipped = !!el._flipped;
  const shapes = []
    .concat(el._autoShapes || [])
    .concat(el._user ? el._user.shapes : [])
    .concat(el._drawing ? [el._drawing] : []);
  shapes.filter((s) => s.from === s.to).forEach((s) => drawArrowShape(svg, s, flipped));
  shapes.filter((s) => s.from !== s.to).forEach((s) => drawArrowShape(svg, s, flipped));
}

function clearUserShapes(el) {
  if (el._user && el._user.shapes.length) {
    el._user.shapes = [];
    renderArrowOverlay(el);
  }
}

function toggleUserShape(el, shape) {
  const list = el._user.shapes;
  const i = list.findIndex((s) => s.from === shape.from && s.to === shape.to);
  if (i >= 0) {
    const same = list[i].brush === shape.brush;
    list.splice(i, 1);
    if (same) return;
  }
  list.push(shape);
}

// the board element outlives re-renders (only its children are rebuilt), so this runs once
function installBoardHandlers(el, allowArrows) {
  if (el._handlersInstalled) return;
  el._handlersInstalled = true;

  // backup for webviews that still start a native selection/drag despite preventDefault
  el.addEventListener("selectstart", (e) => e.preventDefault());
  el.addEventListener("dragstart", (e) => e.preventDefault());
  if (!allowArrows) return;

  el.addEventListener("contextmenu", (e) => e.preventDefault());

  el.addEventListener("pointerdown", (e) => {
    if (e.button === 0) { clearUserShapes(el); return; }
    if (e.button !== 2) return;
    const from = squareFromPoint(el, e.clientX, e.clientY);
    if (!from) return;
    e.preventDefault();
    const brush = brushFromEvent(e);
    el._drawing = { from, to: from, brush, opacity: 0.6 };
    renderArrowOverlay(el);

    const move = (ev) => {
      const sq = squareFromPoint(el, ev.clientX, ev.clientY);
      if (el._drawing && sq && sq !== el._drawing.to) {
        el._drawing.to = sq;
        renderArrowOverlay(el);
      }
    };
    const finish = (commit) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      const d = el._drawing;
      el._drawing = null;
      if (commit && d && el._user) toggleUserShape(el, { from: d.from, to: d.to, brush: d.brush });
      renderArrowOverlay(el);
    };
    const up = (ev) => { if (ev.button === 2) finish(true); };
    const cancel = () => finish(false);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
  });
}

function fenToBoard(fen) {
  const placement = fen.split(" ")[0];
  const rows = placement.split("/"); // rank8 .. rank1
  const board = {};
  rows.forEach((row, rowIdx) => {
    const rank = 8 - rowIdx;
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += parseInt(ch, 10);
      } else {
        board[FILES[file] + rank] = ch;
        file += 1;
      }
    }
  });
  return board;
}

function boardToPlacement(board) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (const file of FILES) {
      const piece = board[file + rank];
      if (piece) {
        if (empty > 0) { row += empty; empty = 0; }
        row += piece;
      } else {
        empty += 1;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}

function squareColor(file, rank) {
  const fi = FILES.indexOf(file);
  const ri = RANKS.indexOf(rank);
  return (fi + ri) % 2 === 0 ? "dark" : "light";
}

function sideToMove(fen) {
  const parts = fen.split(" ");
  return parts[1] === "b" ? "black" : "white";
}

// Lichess order: pawns, then minor/major pieces by value.
const CAPTURE_ORDER = ["p", "n", "b", "r", "q"];
const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

function materialInfo(fen) {
  const board = fenToBoard(fen);
  const remaining = { p: 0, n: 0, b: 0, r: 0, q: 0, P: 0, N: 0, B: 0, R: 0, Q: 0 };
  for (const p of Object.values(board)) if (p in remaining) remaining[p]++;
  let diff = 0;
  const capturedByWhite = []; // black pieces White has taken, drawn as black icons
  const capturedByBlack = []; // white pieces Black has taken, drawn as white icons
  for (const t of CAPTURE_ORDER) {
    const blackLost = START_COUNTS[t] - remaining[t];
    const whiteLost = START_COUNTS[t] - remaining[t.toUpperCase()];
    for (let i = 0; i < blackLost; i++) capturedByWhite.push(t);
    for (let i = 0; i < whiteLost; i++) capturedByBlack.push(t.toUpperCase());
    diff += (blackLost - whiteLost) * PIECE_VALUES[t];
  }
  return { capturedByWhite, capturedByBlack, diff };
}

function renderMaterialSide(el, pieces, lead) {
  const key = pieces.join("") + "|" + lead;
  if (el._materialKey === key) return;
  el._materialKey = key;
  el.textContent = "";
  if (pieces.length === 0 && !lead) return;
  const group = document.createElement("span");
  group.className = "materialGroup";
  for (const p of pieces) {
    const img = document.createElement("img");
    img.src = pieceImageSrc(p);
    img.alt = p;
    group.appendChild(img);
  }
  el.appendChild(group);
  if (lead) {
    const span = document.createElement("span");
    span.className = "materialLead";
    span.textContent = `+${lead}`;
    el.appendChild(span);
  }
}

// Which bar shows which color's captures follows the board's orientation, same as Lichess.
function renderMaterialBars(topEl, bottomEl, fen, flipped) {
  const { capturedByWhite, capturedByBlack, diff } = materialInfo(fen);
  renderMaterialSide(flipped ? topEl : bottomEl, capturedByWhite, diff > 0 ? diff : 0);
  renderMaterialSide(flipped ? bottomEl : topEl, capturedByBlack, diff < 0 ? -diff : 0);
}

function onSquarePointerDown(e, boardEl, sq, piece, opts) {
  if (e.button !== undefined && e.button !== 0) return;
  // otherwise the webview starts a text selection that highlights other squares mid-drag
  e.preventDefault();
  const draggable = !!piece && (!opts.canDrag || opts.canDrag(piece));
  const wasSelected = opts.selected === sq;
  if (draggable && opts.onGrab) opts.onGrab(sq);

  beginPointerDrag(e, {
    boardEl,
    fromSq: sq,
    ghostSrc: draggable ? pieceImageSrc(piece) : null,
    onDrop: (kind, value) => {
      if (kind === "square" && value !== sq && opts.onDropMove) {
        opts.onDropMove(sq, value);
      } else if (kind === "tray" && opts.onDropToTray) {
        opts.onDropToTray(sq);
      }
    },
    onClick: () => {
      if (draggable && opts.onGrab) {
        if (wasSelected && opts.onDeselect) opts.onDeselect();
        return;
      }
      if (opts.onSquareClick) opts.onSquareClick(sq);
    },
  });
}

function buildBoardSquares(el, files, ranks) {
  el.innerHTML = "";
  el._squares = {};
  for (const rank of ranks) {
    for (const file of files) {
      const sq = file + rank;
      const div = document.createElement("div");
      div.dataset.square = sq;
      if (file === files[0]) {
        const rc = document.createElement("span");
        rc.className = "coord rank";
        rc.textContent = rank;
        div.appendChild(rc);
      }
      if (rank === ranks[ranks.length - 1]) {
        const fc = document.createElement("span");
        fc.className = "coord file";
        fc.textContent = file;
        div.appendChild(fc);
      }
      div.addEventListener("pointerdown", (e) => {
        if (el._opts && el._opts.interactive) onSquarePointerDown(e, el, sq, el._board[sq], el._opts);
      });
      el.appendChild(div);
      el._squares[sq] = div;
    }
  }
}

// squares and piece images are reused between calls so redundant redraws don't flash
function renderChessBoard(el, fen, opts) {
  opts = opts || {};
  const board = fenToBoard(fen);
  const flipped = !!opts.flipped;

  el._flipped = flipped;
  el._autoShapes = opts.arrows || [];
  el._opts = opts;
  el._board = board;
  const placement = fen.split(" ")[0];
  if (!el._user || el._user.placement !== placement) el._user = { placement, shapes: [] };
  installBoardHandlers(el, opts.userArrows !== false);

  const files = flipped ? [...FILES].reverse() : FILES;
  const ranks = flipped ? RANKS : [...RANKS].reverse();
  if (el._layout !== flipped) {
    buildBoardSquares(el, files, ranks);
    el._layout = flipped;
  }

  for (const rank of ranks) {
    for (const file of files) {
      const sq = file + rank;
      const div = el._squares[sq];

      let cls = `square ${squareColor(file, rank)}`;
      if (opts.selected === sq) cls += " selected";
      if (opts.lastMove && (opts.lastMove[0] === sq || opts.lastMove[1] === sq)) cls += " last-move";
      if (opts.checkSquare && sq === opts.checkSquare) cls += " in-check";
      const piece = board[sq];
      if (opts.legalTargets && opts.legalTargets.includes(sq)) {
        cls += " move-dot";
        if (piece) cls += " capture";
      }
      div.className = cls;

      if (piece) {
        if (!div._img) {
          const img = document.createElement("img");
          img.className = "piece";
          img.draggable = false;
          img.decoding = "sync";
          div.insertBefore(img, div.firstChild);
          div._img = img;
        }
        if (div._piece !== piece) {
          div._img.src = pieceImageSrc(piece);
          div._img.alt = piece;
          div._piece = piece;
        }
      } else if (div._img) {
        div._img.remove();
        div._img = null;
        div._piece = null;
      }

      const badgeIcon = opts.badge && opts.badge.square === sq && GRADE_BADGE_ICON[opts.badge.grade];
      if (badgeIcon) {
        if (!div._badge) {
          div._badge = document.createElement("img");
          div.appendChild(div._badge);
        }
        div._badge.className = `moveBadge ${gradeClass(opts.badge.grade)}`;
        if (div._badge.getAttribute("src") !== badgeIcon) div._badge.src = badgeIcon;
        div._badge.alt = opts.badge.grade;
      } else if (div._badge) {
        div._badge.remove();
        div._badge = null;
      }
    }
  }

  renderArrowOverlay(el);
  // legal moves can arrive mid-drag and re-render the board
  if (activeDrag && activeDrag.boardEl === el) activeDrag.refresh();
}

function needsPromotionMove(fen, from, to) {
  const board = fenToBoard(fen);
  const piece = board[from];
  if (!piece) return false;
  const isPawn = piece.toLowerCase() === "p";
  const destRank = to[1];
  return isPawn && (destRank === "8" || destRank === "1");
}

function askPromotion(pickerEl, colorPrefix) {
  return new Promise((resolve) => {
    pickerEl.querySelectorAll(".promo-btn").forEach((btn) => {
      const img = btn.querySelector(".promo-img");
      img.src = `img/chesspieces/wikipedia/${colorPrefix}${btn.dataset.piece.toUpperCase()}.png`;
    });
    pickerEl.classList.remove("hidden");
    const handler = (e) => {
      const btn = e.target.closest(".promo-btn");
      if (!btn) return;
      pickerEl.classList.add("hidden");
      pickerEl.removeEventListener("click", handler);
      resolve(btn.dataset.piece);
    };
    pickerEl.addEventListener("click", handler);
  });
}

const tabButtons = document.querySelectorAll(".tabBtn");
const tabPanels = { play: document.getElementById("playTab"), analyze: document.getElementById("analyzeTab") };
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  Object.entries(tabPanels).forEach(([k, el]) => el.classList.toggle("active", k === name));
}

// ---- Play tab ----
const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status-line"),
  moveList: document.getElementById("move-list"),
  startBtn: document.getElementById("start-btn"),
  flipBtn: document.getElementById("flip-btn"),
  resignBtn: document.getElementById("resign-btn"),
  analyzeThisBtn: document.getElementById("analyze-this-btn"),
  sideSelect: document.getElementById("side-select"),
  activeModelName: document.getElementById("active-model-name"),
  noModelHint: document.getElementById("no-model-hint"),
  eloSlider: document.getElementById("elo-slider"),
  eloValue: document.getElementById("elo-value"),
  eloLiveHint: document.getElementById("elo-live-hint"),
  temperatureSlider: document.getElementById("temperature-slider"),
  temperatureValue: document.getElementById("temperature-value"),
  topPSlider: document.getElementById("top-p-slider"),
  topPValue: document.getElementById("top-p-value"),
  promoPicker: document.getElementById("promo-picker"),
  startFenInput: document.getElementById("start-fen-input"),
  clearFenBtn: document.getElementById("clear-fen-btn"),
  fenError: document.getElementById("fen-error"),
  openSetupBtn: document.getElementById("open-setup-btn"),
  undoBtn: document.getElementById("undo-btn"),
  copyPgnBtn: document.getElementById("copy-pgn-btn"),
  historyNotice: document.getElementById("history-notice"),
  goLiveBtn: document.getElementById("go-live-btn"),
  navStart: document.getElementById("nav-start"),
  navPrev: document.getElementById("nav-prev"),
  navNext: document.getElementById("nav-next"),
  navEnd: document.getElementById("nav-end"),
  materialTop: document.getElementById("materialTop"),
  materialBottom: document.getElementById("materialBottom"),
  setupPanel: document.getElementById("setup-panel"),
  setupSummary: document.getElementById("setup-summary"),
  advanced: document.getElementById("advanced-settings"),
  advancedSummary: document.getElementById("advanced-summary"),
  movesMeta: document.getElementById("moves-meta"),
};

let state = {
  fen: STANDARD_FEN,
  turn: "white",
  status: "not-started",
  winner: null,
  lastMove: null,
  sanHistory: [],
};

let playerColor = "white";
let flipped = false;
let selected = null;
let legalTargets = [];
let engineBusy = false;
let gameStarted = false;
let startFen = STANDARD_FEN;

// One entry per ply (0 = start), mirrors the backend's game state.
let posHistory = [{ fen: STANDARD_FEN, lastMove: null }];
let viewPly = 0; // index into posHistory currently shown; live = length-1

els.eloSlider.addEventListener("input", () => { els.eloValue.textContent = els.eloSlider.value; });
els.eloSlider.addEventListener("change", async () => {
  if (!gameStarted || isGameOver()) return; // pre-game, this just sets the value startGame() will read
  const elo = parseInt(els.eloSlider.value, 10);
  try {
    await invoke("set_engine_elo", { elo });
    els.movesMeta.textContent = `You (${playerColor}) vs Maia-3 · ${elo} Elo`;
    setStatus(`Maia-3 Elo set to ${elo} for the rest of this game.`);
  } catch (err) {
    setStatus(`Could not update Elo: ${err}`);
  }
});
els.temperatureSlider.addEventListener("input", () => { els.temperatureValue.textContent = Number(els.temperatureSlider.value).toFixed(2).replace(/0$/, ""); });
els.topPSlider.addEventListener("input", () => { els.topPValue.textContent = Number(els.topPSlider.value).toFixed(2).replace(/0$/, ""); });
els.startBtn.addEventListener("click", startGame);
els.flipBtn.addEventListener("click", () => { flipped = !flipped; renderPlayBoard(); });
els.resignBtn.addEventListener("click", resign);
els.clearFenBtn.addEventListener("click", () => { els.startFenInput.value = ""; hideFenError(); updateAdvancedSummary(); });
els.undoBtn.addEventListener("click", doUndo);
els.copyPgnBtn.addEventListener("click", copyPgn);
function viewMove(ply) {
  viewPly = Math.max(0, Math.min(posHistory.length - 1, ply));
  renderPlayBoard();
  renderMoveList();
}

els.goLiveBtn.addEventListener("click", () => viewMove(posHistory.length - 1));
els.navStart.addEventListener("click", () => viewMove(0));
els.navPrev.addEventListener("click", () => viewMove(viewPly - 1));
els.navNext.addEventListener("click", () => viewMove(viewPly + 1));
els.navEnd.addEventListener("click", () => viewMove(posHistory.length - 1));

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (!document.getElementById("playTab").classList.contains("active")) return;
  if (document.getElementById("setup-overlay").classList.contains("show")) return;
  if (e.target.closest && e.target.closest("input, textarea, select, summary")) return;

  const navTargets = { ArrowLeft: viewPly - 1, ArrowRight: viewPly + 1, Home: 0, End: posHistory.length - 1 };
  if (e.key in navTargets) {
    e.preventDefault();
    viewMove(navTargets[e.key]);
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "f") {
    e.preventDefault();
    els.flipBtn.click();
  } else if (key === "u" && !els.undoBtn.disabled) {
    e.preventDefault();
    els.undoBtn.click();
  } else if (key === "n" && !els.startBtn.disabled) {
    e.preventDefault();
    els.startBtn.click();
  }
});

function selectedSide() {
  return els.sideSelect.querySelector("button.active").dataset.value;
}

els.sideSelect.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  els.sideSelect.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-checked", String(b === btn));
  });
});

function updateAdvancedSummary() {
  els.advancedSummary.textContent = els.startFenInput.value.trim() ? "Advanced · custom position" : "Advanced";
}
els.startFenInput.addEventListener("input", updateAdvancedSummary);
els.setupPanel.querySelector("h2").addEventListener("click", () => els.setupPanel.classList.toggle("collapsed"));
els.analyzeThisBtn.addEventListener("click", sendGameToAnalyze);

function hideFenError() { els.fenError.style.display = "none"; els.fenError.textContent = ""; }
function showFenError(msg) {
  els.fenError.textContent = msg;
  els.fenError.style.display = "block";
  els.advanced.open = true;
}

// Always ONNX; only the first-launch screen in index.html still touches the "maia3.backend" key.
const ENGINE_BACKEND = "onnx";

// Models are installed and chosen on the Setup screen now; this just formats the id for display.
function modelLabel(model) {
  return model.replace("maia3-", "").toUpperCase();
}

// Wrapped since localStorage can throw (privacy mode, disabled storage); shouldn't take the tab down.
const activeModelStore = {
  get() { try { return localStorage.getItem("maia3.activeModel"); } catch { return null; } },
  set(v) { try { localStorage.setItem("maia3.activeModel", v); } catch {} },
};

let activeModelReady = false;

function syncStartButton() {
  els.startBtn.disabled = !activeModelReady;
  els.startBtn.textContent = startLabel();
}

async function refreshActiveModelUI() {
  let ready = [];
  try {
    ready = (await invoke("setup_status")).onnxModelsReady || [];
  } catch {
    ready = [];
  }
  const stored = activeModelStore.get();
  // Falls back to an installed model if the stored choice was removed since the app last loaded.
  const active = (stored && ready.includes(stored)) ? stored : (ready[0] || null);
  if (active) activeModelStore.set(active);

  activeModelReady = !!active;
  els.activeModelName.textContent = active ? modelLabel(active) : "None installed";
  els.noModelHint.style.display = active ? "none" : "block";
  syncStartButton();
}

function getActiveModel() {
  const model = activeModelStore.get();
  if (!model) throw new Error("No Maia-3 model installed — install one on the Setup screen.");
  return model;
}

refreshActiveModelUI();

async function listenSetupProgress(task, handler) {
  return await listen("setup-progress", (e) => {
    if (e.payload && e.payload.task === task) handler(e.payload);
  });
}

function startLabel() {
  return gameStarted && !isGameOver() ? "Start new game" : "Start game";
}

async function startGame() {
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Loading model…";
  setStatus("Starting Maia-3 — first run may need to download the checkpoint…");

  try {
    const fenInput = els.startFenInput.value.trim();
    if (fenInput) {
      try {
        await invoke("validate_fen", { fen: fenInput });
      } catch (err) {
        showFenError(String(err));
        els.startBtn.disabled = false;
        els.startBtn.textContent = startLabel();
        setStatus("Fix the Start FEN before starting.");
        return;
      }
    }
    hideFenError();

    const chosen = selectedSide();
    playerColor = chosen === "random" ? (Math.random() < 0.5 ? "white" : "black") : chosen;
    flipped = playerColor === "black";

    const model = getActiveModel();
    const elo = parseInt(els.eloSlider.value, 10);
    const temperature = els.temperatureSlider.value;
    const topP = els.topPSlider.value;

    state = await invoke("new_game", { fen: fenInput || null });
    startFen = state.fen === STANDARD_FEN ? STANDARD_FEN : (fenInput || state.fen);
    posHistory = [{ fen: state.fen, lastMove: null }];
    viewPly = 0;

    await invoke("start_engine", {
      command: model,
      elo,
      backend: ENGINE_BACKEND,
      extraArgs: [
        "--temperature", String(temperature),
        "--top-p", String(topP),
        // Fresh seed per game so temperature > 0 actually varies between games.
        "--seed", String((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
      ],
    });

    gameStarted = true;
    selected = null;
    legalTargets = [];
    els.setupSummary.textContent = `${playerColor === "white" ? "White" : "Black"} · ${elo} · ${model.replace("maia3-", "").toUpperCase()}`;
    els.movesMeta.textContent = `You (${playerColor}) vs Maia-3 · ${elo} Elo`;
    els.setupPanel.classList.add("collapsed");
    els.eloLiveHint.style.display = "";
    renderPlayBoard();
    renderMoveList();
    const tempNote = Number(temperature) > 0 ? `, temp ${temperature}` : ", greedy";
    setStatus(`Playing as ${playerColor}. Maia-3 (${model}, ${elo} Elo${tempNote}) is your opponent.`);

    if (state.turn !== playerColor) {
      await triggerEngineMove();
    }
  } catch (err) {
    setStatus(`Could not start engine: ${err}`);
  } finally {
    syncStartButton();
  }
}

async function resign() {
  if (!gameStarted || isGameOver()) return;
  gameStarted = false;
  state.status = "resigned";
  state.winner = playerColor === "white" ? "black" : "white";
  await invoke("stop_engine").catch(() => {});
  renderPlayBoard();
  renderMoveList();
  setStatus("You resigned.");
}

function isGameOver() {
  return ["checkmate", "stalemate", "draw", "resigned"].includes(state.status);
}

function setStatus(text) { els.status.textContent = text; }

function statusBanner() {
  switch (state.status) {
    case "checkmate":
      return `Checkmate — ${state.winner === playerColor ? "you win!" : "Maia-3 wins."}`;
    case "stalemate": return "Draw by stalemate.";
    case "draw": return "Draw.";
    case "resigned": return "You resigned.";
    default: return state.turn === playerColor ? "Your move." : "Maia-3 is thinking…";
  }
}

async function triggerEngineMove() {
  if (isGameOver()) return;
  engineBusy = true;
  updateControls();
  setStatus("Maia-3 is thinking…");
  try {
    state = await invoke("engine_move");
    posHistory.push({ fen: state.fen, lastMove: state.lastMove });
    viewPly = posHistory.length - 1;
    renderPlayBoard();
    renderMoveList();
  } catch (err) {
    setStatus(`Engine error: ${err}`);
  } finally {
    engineBusy = false;
    updateControls();
    if (!isGameOver()) setStatus(statusBanner());
  }
}

async function attemptMove(from, to) {
  if (!isLive()) return;
  const promoNeeded = needsPromotionMove(state.fen, from, to);
  let promotion = null;
  if (promoNeeded) {
    const prefix = playerColor === "white" ? "w" : "b";
    promotion = await askPromotion(els.promoPicker, prefix);
    if (!promotion) { clearSelection(); renderPlayBoard(); return; }
  }

  try {
    state = await invoke("make_move", { from, to, promotion });
    posHistory.push({ fen: state.fen, lastMove: state.lastMove });
    viewPly = posHistory.length - 1;
    clearSelection();
    renderPlayBoard();
    renderMoveList();
    if (isGameOver()) { setStatus(statusBanner()); return; }
    setStatus(statusBanner());
    if (state.turn !== playerColor) {
      await triggerEngineMove();
      if (isGameOver()) setStatus(statusBanner());
    }
  } catch (err) {
    clearSelection();
    renderPlayBoard();
  }
}

function clearSelection() { selected = null; legalTargets = []; }

function isLive() { return viewPly === posHistory.length - 1; }
function currentViewFen() { return posHistory[viewPly] ? posHistory[viewPly].fen : state.fen; }

function findKingInCheckSquare(board, turnColor) {
  const kingChar = turnColor === "white" ? "K" : "k";
  for (const [sq, p] of Object.entries(board)) if (p === kingChar) return sq;
  return null;
}

let gameOverHandled = false;

function updateControls() {
  if (isGameOver()) {
    if (!gameOverHandled) {
      els.setupPanel.classList.remove("collapsed");
      els.eloLiveHint.style.display = "none";
    }
    gameOverHandled = true;
  } else {
    gameOverHandled = false;
  }
  els.historyNotice.classList.toggle("show", !isLive());
  els.navStart.disabled = viewPly === 0;
  els.navPrev.disabled = viewPly === 0;
  els.navNext.disabled = viewPly >= posHistory.length - 1;
  els.navEnd.disabled = viewPly >= posHistory.length - 1;
  els.undoBtn.disabled = !gameStarted || posHistory.length <= 1 || engineBusy;
  els.copyPgnBtn.disabled = posHistory.length <= 1;
  els.analyzeThisBtn.disabled = posHistory.length <= 1;
}

function renderPlayBoard() {
  const viewingLive = isLive();
  const fen = currentViewFen();
  const entry = posHistory[viewPly] || { lastMove: null };

  updateControls();

  const board = fenToBoard(fen);
  const checkSquare = (viewingLive && state.inCheck) ? findKingInCheckSquare(board, sideToMove(fen)) : null;

  renderMaterialBars(els.materialTop, els.materialBottom, fen, flipped);
  renderChessBoard(els.board, fen, {
    flipped,
    selected: viewingLive ? selected : null,
    legalTargets: viewingLive ? legalTargets : [],
    lastMove: entry.lastMove,
    checkSquare,
    interactive: viewingLive,
    canDrag: (piece) => canPlayerMove() && isPieceOfColor(piece, playerColor),
    onGrab: onPlaySquareClick,
    onDeselect: () => { clearSelection(); renderPlayBoard(); },
    onSquareClick: onPlaySquareClick,
    onDropMove: (from, to) => {
      if (selected === from && legalTargets.length > 0 && !legalTargets.includes(to)) {
        renderPlayBoard();
        return;
      }
      clearSelection();
      attemptMove(from, to);
    },
  });
}

function canPlayerMove() {
  return gameStarted && !isGameOver() && !engineBusy && isLive() && state.turn === playerColor;
}

async function onPlaySquareClick(sq) {
  if (!gameStarted || isGameOver() || engineBusy || !isLive()) return;
  if (state.turn !== playerColor) return;

  const board = fenToBoard(state.fen);
  const piece = board[sq];
  const isOwnPiece = piece && ((playerColor === "white" && piece === piece.toUpperCase()) ||
                                (playerColor === "black" && piece === piece.toLowerCase()));

  if (selected && legalTargets.includes(sq)) {
    const from = selected;
    clearSelection();
    await attemptMove(from, sq);
    return;
  }

  if (isOwnPiece) {
    if (selected === sq) return;
    selected = sq;
    legalTargets = [];
    renderPlayBoard();
    let targets = [];
    try { targets = await invoke("legal_targets", { square: sq }); } catch { targets = []; }
    // piece was dropped or another one picked while this was in flight
    if (selected !== sq) return;
    legalTargets = targets;
    renderPlayBoard();
    return;
  }

  clearSelection();
  renderPlayBoard();
}

// Numbering follows the start position, which can be Black to move or mid-game.
function movePairs(sans, fen) {
  const parts = (fen || STANDARD_FEN).split(" ");
  let isWhite = parts[1] !== "b";
  let num = parseInt(parts[5], 10) || 1;
  const rows = [];
  let row = null;
  sans.forEach((san, i) => {
    if (!row || isWhite) {
      row = { num, white: null, black: null };
      rows.push(row);
    }
    row[isWhite ? "white" : "black"] = { san, ply: i + 1 };
    if (!isWhite) num += 1;
    isWhite = !isWhite;
  });
  return rows;
}

function gameResult(st) {
  if (st.status === "checkmate" || st.status === "resigned") return st.winner === "white" ? "1-0" : "0-1";
  if (st.status === "stalemate" || st.status === "draw") return "1/2-1/2";
  return null;
}

const RESULT_REASON = { checkmate: "checkmate", resigned: "resignation", stalemate: "stalemate", draw: "draw" };

function renderMoveList() {
  const list = els.moveList;
  list.innerHTML = "";
  const history = state.sanHistory || [];
  if (history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "move-empty";
    empty.textContent = "No moves yet.";
    list.appendChild(empty);
    return;
  }

  movePairs(history, startFen).forEach((row) => {
    const li = document.createElement("li");
    li.className = "move-row";
    const numEl = document.createElement("span");
    numEl.className = "move-num";
    numEl.textContent = `${row.num}.`;
    li.appendChild(numEl);

    [row.white, row.black].forEach((m, side) => {
      const cell = document.createElement("span");
      cell.className = "move-san";
      if (m) {
        cell.textContent = m.san;
        if (m.ply === viewPly) cell.classList.add("current");
        cell.addEventListener("click", () => viewMove(m.ply));
      } else {
        cell.classList.add("empty");
        // A missing White move only happens when the game starts with Black to move.
        cell.textContent = side === 0 ? "…" : "";
      }
      li.appendChild(cell);
    });
    list.appendChild(li);
  });

  const result = gameResult(state);
  if (result) {
    const li = document.createElement("li");
    li.className = "move-result";
    li.textContent = result;
    const why = document.createElement("small");
    why.textContent = RESULT_REASON[state.status] || "";
    li.appendChild(why);
    list.appendChild(li);
  }

  // Keep the current move in view without scrolling anything outside the list.
  const cur = list.querySelector(".current");
  if (!cur) { list.scrollTop = viewPly === 0 ? 0 : list.scrollHeight; return; }
  const lr = list.getBoundingClientRect();
  const cr = cur.getBoundingClientRect();
  if (cr.top < lr.top) list.scrollTop -= lr.top - cr.top;
  else if (cr.bottom > lr.bottom) list.scrollTop += cr.bottom - lr.bottom;
}

async function doUndo() {
  if (!gameStarted || posHistory.length <= 1 || engineBusy) return;
  // A fixed 2 plies left the engine on move (board dead) whenever its last reply had failed, so go back to the player's turn instead.
  let removed = 0;
  while (posHistory.length > 1) {
    try {
      state = await invoke("undo_move");
      posHistory.pop();
      removed += 1;
    } catch { break; }
    if (state.turn === playerColor) break;
  }
  if (removed === 0) return;
  viewPly = posHistory.length - 1;
  clearSelection();
  renderPlayBoard();
  renderMoveList();
  setStatus(statusBanner());
  if (!isGameOver() && state.turn !== playerColor) triggerEngineMove();
}

function sanHistoryToPgn(sanHistory, fenForHeader, result) {
  const lines = [];
  if (fenForHeader && fenForHeader !== STANDARD_FEN) {
    lines.push('[SetUp "1"]');
    lines.push(`[FEN "${fenForHeader}"]`);
  }
  const parts = movePairs(sanHistory, fenForHeader).map((row) => {
    if (row.white) return `${row.num}. ${row.white.san}${row.black ? " " + row.black.san : ""}`;
    return `${row.num}... ${row.black.san}`;
  });
  if (result) parts.push(result);
  lines.push(parts.join(" "));
  return lines.join("\n");
}

async function copyPgn() {
  const pgn = sanHistoryToPgn(state.sanHistory, startFen, gameResult(state));
  try {
    await navigator.clipboard.writeText(pgn);
    const original = els.copyPgnBtn.textContent;
    els.copyPgnBtn.textContent = "Copied!";
    setTimeout(() => { els.copyPgnBtn.textContent = original; }, 1200);
  } catch {
    window.prompt("Copy PGN:", pgn);
  }
}

function sendGameToAnalyze() {
  if (posHistory.length <= 1) return;
  const fens = posHistory.slice(1).map((p) => p.fen);
  loadAnalysisGame({
    startFen: startFen,
    sans: state.sanHistory.slice(),
    fens,
    myColor: playerColor,
  });
  switchTab("analyze");
}

renderPlayBoard();

// ---- Position editor ----
const ed = {
  overlay: document.getElementById("setup-overlay"),
  board: document.getElementById("editor-board"),
  trayWhite: document.getElementById("trayWhite"),
  trayBlack: document.getElementById("trayBlack"),
  turnSelect: document.getElementById("editorTurnSelect"),
  castleWK: document.getElementById("castleWK"),
  castleWQ: document.getElementById("castleWQ"),
  castleBK: document.getElementById("castleBK"),
  castleBQ: document.getElementById("castleBQ"),
  fenPreview: document.getElementById("fenPreview"),
  error: document.getElementById("editorError"),
  standardBtn: document.getElementById("editorStandardBtn"),
  clearBtn: document.getElementById("editorClearBtn"),
  applyBtn: document.getElementById("editorApplyBtn"),
  cancelBtn: document.getElementById("editorCancelBtn"),
};

let editorBoardState = {}; // {square: pieceChar}

function buildTray(container, color) {
  container.innerHTML = "";
  const order = ["K", "Q", "R", "B", "N", "P"];
  for (const letter of order) {
    const piece = color === "white" ? letter : letter.toLowerCase();
    const img = document.createElement("img");
    img.className = "piece";
    img.src = pieceImageSrc(piece);
    img.alt = piece;
    img.dataset.piece = piece;
    img.draggable = false;
    img.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      beginPointerDrag(e, {
        ghostSrc: pieceImageSrc(piece),
        onDrop: (kind, value) => {
          if (kind === "square") {
            editorBoardState[value] = piece;
            renderEditorBoard();
          }
        },
      });
    });
    container.appendChild(img);
  }
}
buildTray(ed.trayWhite, "white");
buildTray(ed.trayBlack, "black");

function renderEditorBoard() {
  renderChessBoard(ed.board, boardFenOnly(), {
    interactive: true,
    userArrows: false,
    onSquareClick: (sq) => {
      if (editorBoardState[sq]) { delete editorBoardState[sq]; renderEditorBoard(); }
    },
    onDropMove: (from, to) => {
      editorBoardState[to] = editorBoardState[from];
      delete editorBoardState[from];
      renderEditorBoard();
    },
    onDropToTray: (from) => {
      delete editorBoardState[from];
      renderEditorBoard();
    },
  });
  updateFenPreview();
}

function boardFenOnly() {
  return boardToPlacement(editorBoardState) + " w - - 0 1";
}

// checkboxes go stale when the board is cleared/edited, so verify against the actual pieces
function canCastle(board, side, kingSide) {
  const rank = side === "w" ? "1" : "8";
  const king = side === "w" ? "K" : "k";
  const rook = side === "w" ? "R" : "r";
  const rookFile = kingSide ? "h" : "a";
  return board["e" + rank] === king && board[rookFile + rank] === rook;
}

function buildEditorFen() {
  const placement = boardToPlacement(editorBoardState);
  const turn = ed.turnSelect.value;
  let castling = "";
  if (ed.castleWK.checked && canCastle(editorBoardState, "w", true)) castling += "K";
  if (ed.castleWQ.checked && canCastle(editorBoardState, "w", false)) castling += "Q";
  if (ed.castleBK.checked && canCastle(editorBoardState, "b", true)) castling += "k";
  if (ed.castleBQ.checked && canCastle(editorBoardState, "b", false)) castling += "q";
  if (!castling) castling = "-";
  return `${placement} ${turn} ${castling} - 0 1`;
}

function updateFenPreview() {
  ed.fenPreview.textContent = buildEditorFen();
}

function loadStandardIntoEditor() {
  editorBoardState = fenToBoard(STANDARD_FEN);
  ed.turnSelect.value = "w";
  ed.castleWK.checked = ed.castleWQ.checked = ed.castleBK.checked = ed.castleBQ.checked = true;
  renderEditorBoard();
}

ed.standardBtn.addEventListener("click", loadStandardIntoEditor);
ed.clearBtn.addEventListener("click", () => {
  editorBoardState = {};
  ed.castleWK.checked = ed.castleWQ.checked = ed.castleBK.checked = ed.castleBQ.checked = false;
  renderEditorBoard();
});
[ed.turnSelect, ed.castleWK, ed.castleWQ, ed.castleBK, ed.castleBQ].forEach((el) => {
  el.addEventListener("change", updateFenPreview);
});

els.openSetupBtn.addEventListener("click", () => {
  ed.error.textContent = "";
  const startingFen = els.startFenInput.value.trim() || state.fen || STANDARD_FEN;
  editorBoardState = fenToBoard(startingFen);
  const parts = startingFen.split(" ");
  ed.turnSelect.value = parts[1] === "b" ? "b" : "w";
  const castling = parts[2] || "-";
  ed.castleWK.checked = castling.includes("K");
  ed.castleWQ.checked = castling.includes("Q");
  ed.castleBK.checked = castling.includes("k");
  ed.castleBQ.checked = castling.includes("q");
  renderEditorBoard();
  ed.overlay.classList.add("show");
});
ed.cancelBtn.addEventListener("click", () => ed.overlay.classList.remove("show"));

ed.applyBtn.addEventListener("click", async () => {
  const fen = buildEditorFen();
  ed.error.textContent = "";
  try {
    await invoke("validate_fen", { fen });
  } catch (err) {
    ed.error.textContent = String(err);
    return;
  }
  els.startFenInput.value = fen;
  els.advanced.open = true;
  updateAdvancedSummary();
  hideFenError();
  ed.overlay.classList.remove("show");
  setStatus("Position loaded — click New Game to play it.");
});

// ---- Analyze / practice ----
const az = {
  board: document.getElementById("analyzeBoard"),
  promo: document.getElementById("analyzePromo"),
  flipBtn: document.getElementById("aFlipBtn"),
  evalGraph: document.getElementById("evalGraph"),
  evalBox: document.getElementById("evalGraphBox"),
  evalInfo: document.getElementById("evalInfo"),
  evalLine: document.getElementById("evalLine"),
  evalLegend: document.getElementById("evalLegend"),
  pgnInput: document.getElementById("pgnInput"),
  loadBtn: document.getElementById("loadGameBtn"),
  loadError: document.getElementById("loadError"),
  sideSelect: document.getElementById("analyzeSideSelect"),
  depthSelect: document.getElementById("analyzeDepthSelect"),
  analyzeBtn: document.getElementById("analyzeGameBtn"),
  analyzeStatus: document.getElementById("analyzeStatus"),
  sidebar: document.getElementById("analyzeSidebar"),
  loadPanel: document.getElementById("loadPanel"),
  controlsPanel: document.getElementById("analyzeControlsPanel"),
  moveListPanel: document.getElementById("moveListPanel"),
  moveList: document.getElementById("analyzeMoveList"),
  flaggedPanel: document.getElementById("flaggedPanel"),
  flaggedList: document.getElementById("flaggedList"),
  flaggedHeading: document.getElementById("flaggedHeading"),
  flaggedCount: document.getElementById("flaggedCount"),
  practiceSideRow: document.getElementById("practiceSideRow"),
  practiceSideSelect: document.getElementById("practiceSideSelect"),
  practiceBtn: document.getElementById("practiceBtn"),
  navStart: document.getElementById("aNavStart"),
  navPrev: document.getElementById("aNavPrev"),
  navNext: document.getElementById("aNavNext"),
  navEnd: document.getElementById("aNavEnd"),
  puzzlePanel: document.getElementById("puzzlePanelV2"),
  puzzleProgress: document.getElementById("puzzleProgressV2"),
  puzzlePrompt: document.getElementById("puzzlePromptV2"),
  puzzleFeedback: document.getElementById("puzzleFeedbackV2"),
  puzzleActiveActions: document.getElementById("puzzleActiveActions"),
  puzzleDoneActions: document.getElementById("puzzleDoneActions"),
  puzzleRevealBtn: document.getElementById("puzzleRevealBtn"),
  puzzleBackBtn: document.getElementById("puzzleBackBtn"),
  puzzleExitBtn: document.getElementById("puzzleExitBtn"),
  puzzleExitBtn2: document.getElementById("puzzleExitBtn2"),
  puzzleRestartBtn: document.getElementById("puzzleRestartBtn"),
  puzzleNextBtn: document.getElementById("puzzleNextBtn"),
  arrowToggle: document.getElementById("aArrowToggle"),
  variationBar: document.getElementById("variationBar"),
  variationTitle: document.getElementById("variationTitle"),
  variationLine: document.getElementById("variationLine"),
  variationExitBtn: document.getElementById("variationExitBtn"),
  materialTop: document.getElementById("aMaterialTop"),
  materialBottom: document.getElementById("aMaterialBottom"),
};

let loadedGame = null;      // {startFen, sans, fens}
let analysis = null;        // Vec<MoveAnalysis> from analyze_pgn/analyze_moves
let azViewPly = 0;          // 0 = start position, i = after sans[i-1]
let azFlipped = false;      // Analyze board orientation (true = Black at the bottom)
let stockfishStarted = false;
// Side line off the game: an engine line being previewed, or the user's own moves.
// { ply, m, fens, ucis, idx, free?, sans? } — `free` lines can be branched by moving pieces.
let variation = null;

// ---- Live engine (Stockfish on whatever is on the Analyze board) ----
const eng = {
  enable: document.getElementById("engEnable"),
  lines: document.getElementById("engLines"),
  note: document.getElementById("engNote"),
  body: document.getElementById("engBody"),
  score: document.getElementById("engScore"),
  barFill: document.getElementById("engBarFill"),
  status: document.getElementById("engStatus"),
  list: document.getElementById("engList"),
  arrows: document.getElementById("engArrows"),
};
const ENG_DEBOUNCE_MS = 250;
const ENG_DEPTH = 10;
let engToken = 0;
let engKey = null;     // position/settings the current search belongs to
let engLive = null;    // { key, lines } latest result for the arrow and list
let analyzingGame = false;
const engCache = new Map();
// Remainders of searched lines, so stepping along one shows something instantly.
const engSeed = new Map();
let analysisDepth = 0;

function engSeedLine(startFen, line, depth) {
  if (line.mate !== null && line.mate !== undefined) return;   // mate distances change along the line
  const fens = [startFen].concat(line.fens || []);
  for (let k = 0; k < line.ucis.length && depth - k >= 6; k++) {
    const key = fenKey(fens[k]);
    const have = engSeed.get(key);
    if (have && have.depth >= depth - k) continue;
    engSeed.set(key, {
      depth: depth - k,
      lines: [{
        multipv: 1, depth: depth - k, scoreCp: line.scoreCp, mate: null,
        sans: line.sans.slice(k), ucis: line.ucis.slice(k), fens: (line.fens || []).slice(k),
      }],
    });
  }
}

// Free piece moves on the Analyze board.
let azSelected = null;
let azTargets = [];
let azSelFen = null;

// ---- Human insights (Maia move probabilities per rating) ----
// Adapted from CSSLab/maia-platform-frontend (GPL-3.0).
const HI_CHART_RATINGS = Array.from({ length: 11 }, (_, i) => 600 + i * 200);
const HI_LINE_COLORS = ["#4caf6b", "#3b6ef2", "#e68f00", "#c06be0", "#26c2c2"];
const HI_CLASS_COLORS = { good: "#4caf6b", ok: "#e3c96b", blunder: "#e05555" };
const HI_CLASS_LABELS = { good: "Good", ok: "Okay", blunder: "Blunder" };
const HI_PENDING_COLOR = "#5a86f5";
const HI_SCORE_DEPTH = 10;

const hi = {
  panel: document.getElementById("humanPanel"),
  enable: document.getElementById("hiEnable"),
  rating: document.getElementById("hiRating"),
  status: document.getElementById("hiStatus"),
  body: document.getElementById("hiBody"),
  summary: document.getElementById("hiSummary"),
  meter: document.getElementById("hiMeter"),
  meterLegend: document.getElementById("hiMeterLegend"),
  moves: document.getElementById("hiMoves"),
  chart: document.getElementById("hiChart"),
  chartLegend: document.getElementById("hiChartLegend"),
  arrows: document.getElementById("hiArrows"),
  chartBox: document.getElementById("hiChartBox"),
};

const hiPromises = new Map();
const hiData = new Map();
let hiToken = 0;
let hiEnginesReady = false;
let hiRedrawing = false;

for (let r = 600; r <= 2600; r += 100) {
  const opt = document.createElement("option");
  opt.value = String(r);
  opt.textContent = `Maia ${r}`;
  if (r === 1500) opt.selected = true;
  hi.rating.appendChild(opt);
}

function hiRating() { return parseInt(hi.rating.value, 10); }
function hiPct(p) { return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`; }

function hiOnce(key, load) {
  if (!hiPromises.has(key)) {
    const started = performance.now();
    const p = load().then((value) => {
      hiData.set(key, value);
      console.debug(`[insights] ${key} ${Math.round(performance.now() - started)}ms`);
      return value;
    }, (err) => {
      hiPromises.delete(key);
      throw err;
    });
    hiPromises.set(key, p);
  }
  return hiPromises.get(key);
}

async function hiContext(ply) {
  const ucis = await hiUcis();
  return { startFen: loadedGame.startFen, ucis: ucis.slice(0, ply), played: ucis[ply] || null };
}

function hiFetchMoves(ply, rating) {
  return hiOnce(`moves:${ply}:${rating}`, async () =>
    invoke("human_moves", { ...(await hiContext(ply)), ratings: [rating], rating }));
}

function hiFetchChart(ply) {
  return hiOnce(`chart:${ply}`, async () =>
    invoke("human_moves", { ...(await hiContext(ply)), ratings: HI_CHART_RATINGS, rating: HI_CHART_RATINGS[0] }));
}

function hiFetchScores(ply, rating, moves) {
  return hiOnce(`scores:${ply}:${rating}`, async () => {
    const ctx = await hiContext(ply);
    return invoke("score_human_moves", {
      startFen: ctx.startFen,
      ucis: ctx.ucis,
      moves: moves.moves.map((m) => m.uci),
      depth: HI_SCORE_DEPTH,
    });
  });
}

function hiResetForGame() {
  hiPromises.clear();
  hiData.clear();
  hiToken++;
  estReset();
  hi.panel.style.display = "block";
  hi.body.style.display = "none";
  hi.status.textContent = "";
}

let hiMaiaStart = null;

function hiEnsureMaia() {
  if (!hiMaiaStart) {
    hiMaiaStart = invoke("start_insights_engine", { command: getActiveModel() }).catch((err) => {
      hiMaiaStart = null;
      throw err;
    });
  }
  return hiMaiaStart;
}

async function hiEnsureEngines() {
  if (hiEnginesReady) return true;
  hi.status.textContent = "Starting engines…";
  const [sfOk, maiaErr] = await Promise.all([
    ensureStockfish(),
    hiEnsureMaia().then(() => null, (err) => err),
  ]);
  if (!sfOk) {
    hi.status.textContent = az.analyzeStatus.textContent;
    return false;
  }
  if (maiaErr) {
    hi.status.textContent = "Maia isn't available: " + maiaErr;
    return false;
  }
  hiEnginesReady = true;
  return true;
}

// Games sent from the Play tab only carry SANs, so the UCI moves come from a round trip through the PGN parser.
async function hiUcis() {
  if (!loadedGame.ucis) {
    const pgn = sanHistoryToPgn(loadedGame.sans, loadedGame.startFen, "*");
    loadedGame.ucis = (await invoke("parse_pgn", { pgnText: pgn })).ucis;
  }
  return loadedGame.ucis;
}

function hiArrowsFrom(moves) {
  if (!moves) return [];
  return moves.moves.slice(0, 2).map((m) => {
    const sq = uciToSquares(m.uci);
    return sq ? { from: sq[0], to: sq[1], brush: "human", opacity: 0.5 + 0.4 * m.prob } : null;
  }).filter(Boolean);
}

function hiArrowsAt(ply) {
  if (!hi.enable.checked || !hi.arrows.checked) return [];
  return hiArrowsFrom(hiData.get(`moves:${ply}:${hiRating()}`));
}

function hiRedrawBoard() {
  if (puzzleMode) return;
  hiRedrawing = true;
  try { renderAnalyzeBoard(); } finally { hiRedrawing = false; }
}

async function hiRefresh() {
  if (hiRedrawing) return;
  if (!hi.enable.checked || !loadedGame || variation || puzzleMode) {
    hiToken++;
    hi.body.style.display = "none";
    if (!hi.enable.checked) hi.status.textContent = "";
    return;
  }

  const token = ++hiToken;
  const ply = azViewPly;
  const rating = hiRating();
  if (!hiData.has(`moves:${ply}:${rating}`)) {
    hi.status.textContent = "Thinking…";
    await new Promise((r) => setTimeout(r, 250));
    if (token !== hiToken) return;
    if (!(await hiEnsureEngines())) return;
  }

  let moves;
  try {
    moves = await hiFetchMoves(ply, rating);
  } catch (err) {
    if (token === hiToken) hi.status.textContent = "Insights failed: " + err;
    return;
  }
  if (token !== hiToken || puzzleMode) return;

  hi.status.textContent = "";
  hiRender(ply, rating);
  hiRedrawBoard();

  const rerender = () => { if (token === hiToken && !puzzleMode) hiRender(ply, rating); };
  hiFetchScores(ply, rating, moves).then(rerender, (err) => {
    if (token === hiToken) hi.status.textContent = "Scoring failed: " + err;
  });
  if (hi.chartBox.open) hiFetchChart(ply).then(rerender, () => {});
}

function hiRender(ply, rating) {
  const moves = hiData.get(`moves:${ply}:${rating}`);
  if (!moves) return;
  if (!moves.moves.length) {
    hi.body.style.display = "none";
    hi.status.textContent = "No moves to show here (game over).";
    return;
  }
  const scores = hiData.get(`scores:${ply}:${rating}`);
  const byUci = new Map((scores ? scores.scores : []).map((s) => [s.uci, s]));
  const rows = moves.moves.map((m) => ({ ...m, score: byUci.get(m.uci) || null }));

  hi.body.style.display = "block";
  hiRenderSummary(rows, rating);
  hiRenderMeter(rows, scores !== undefined);
  hiRenderMoves(rows, scores ? scores.bestUci : null);
  if (hi.chartBox.open) hiRenderChart(rows, hiData.get(`chart:${ply}`), rating);
}

function hiRenderSummary(rows, rating) {
  const played = rows.find((r) => r.played);
  hi.summary.textContent = "";
  if (played) {
    const b = document.createElement("b");
    b.textContent = played.san;
    hi.summary.append(b, ` was played — a ${rating} player chooses it ${hiPct(played.prob)} of the time. `);
  } else {
    hi.summary.append("Most likely moves for this position. ");
  }
  hi.summary.append(`Top human choice: ${rows[0].san} (${hiPct(rows[0].prob)}).`);
}

function hiRenderMeter(rows, scored) {
  hi.meter.textContent = "";
  hi.meterLegend.textContent = "";
  if (!scored) {
    const seg = document.createElement("div");
    seg.style.width = "100%";
    seg.style.background = "#2c3038";
    hi.meter.appendChild(seg);
    hi.meterLegend.textContent = "Scoring moves…";
    return;
  }

  const sums = { good: 0, ok: 0, blunder: 0 };
  rows.forEach((r) => { if (r.score) sums[r.score.class] += r.prob; });
  const total = sums.good + sums.ok + sums.blunder || 1;

  for (const cls of ["good", "ok", "blunder"]) {
    const share = sums[cls] / total;
    const seg = document.createElement("div");
    seg.style.width = `${share * 100}%`;
    seg.style.background = HI_CLASS_COLORS[cls];
    seg.title = `${HI_CLASS_LABELS[cls]}: ${hiPct(share)}`;
    hi.meter.appendChild(seg);

    const label = document.createElement("span");
    label.style.color = HI_CLASS_COLORS[cls];
    label.textContent = `${HI_CLASS_LABELS[cls]} ${Math.round(share * 100)}%`;
    hi.meterLegend.appendChild(label);
  }
}

function hiRenderMoves(rows, bestUci) {
  hi.moves.textContent = "";
  const top = rows[0].prob || 1;
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "hiRow" + (r.played ? " played" : "") + (r.uci === bestUci ? " best" : "");
    if (r.score) row.title = `Loses ${(r.score.winLoss * 100).toFixed(1)}% win chance vs the engine's best`;

    const san = document.createElement("span");
    san.className = "san";
    san.textContent = r.san;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${(r.prob / top) * 100}%`;
    fill.style.background = r.score ? HI_CLASS_COLORS[r.score.class] : HI_PENDING_COLOR;
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = hiPct(r.prob);

    row.append(san, bar, pct);
    hi.moves.appendChild(row);
  }
}

function hiRenderChart(rows, chartData, rating) {
  const W = 320, H = 150, L = 30, R = 8, T = 8, B = 20;
  const svg = hi.chart;
  svg.textContent = "";
  hi.chartLegend.textContent = "";

  if (!chartData) {
    svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": 11, fill: "#9aa0ab" }, svg).textContent = "Loading…";
    return;
  }

  const ratings = chartData.maia.ratings;
  const shown = rows.slice(0, 4);
  const played = rows.find((r) => r.played);
  if (played && !shown.includes(played)) shown.push(played);

  const series = shown.map((r) => chartData.maia.policies.map((pol) => pol[r.uci] || 0));
  const yMax = Math.max(0.1, ...series.flat());
  const lo = ratings[0], hiR = ratings[ratings.length - 1];
  const x = (rt) => L + ((rt - lo) / (hiR - lo)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);

  for (const frac of [0, 0.5, 1]) {
    const gy = y(yMax * frac);
    svgEl("line", { x1: L, x2: W - R, y1: gy, y2: gy, stroke: "#2c3038", "stroke-width": 1 }, svg);
    svgEl("text", { x: L - 4, y: gy + 3, "text-anchor": "end", "font-size": 9, fill: "#9aa0ab" }, svg).textContent = `${Math.round(yMax * frac * 100)}%`;
  }
  for (const rt of [600, 1100, 1600, 2100, 2600]) {
    svgEl("text", { x: x(rt), y: H - 5, "text-anchor": "middle", "font-size": 9, fill: "#9aa0ab" }, svg).textContent = rt;
  }
  svgEl("line", { x1: x(rating), x2: x(rating), y1: T, y2: H - B, stroke: "#5a86f5", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);

  series.forEach((values, n) => {
    const color = HI_LINE_COLORS[n % HI_LINE_COLORS.length];
    const points = values.map((v, i) => `${x(ratings[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svgEl("polyline", { points, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);

    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = color;
    item.append(swatch, shown[n].san);
    hi.chartLegend.appendChild(item);
  });
}

hi.enable.addEventListener("change", () => {
  if (puzzleMode) { hiSyncPuzzle(); return; }
  hiRefresh();
  if (!hi.enable.checked) renderAnalyzeBoard();
});
hi.rating.addEventListener("change", () => { if (puzzleMode) hiSyncPuzzle(); else hiRefresh(); });
hi.chartBox.addEventListener("toggle", () => { if (hi.chartBox.open) hiRefresh(); });
hi.arrows.addEventListener("change", () => { if (puzzleMode) hiSyncPuzzle(); else renderAnalyzeBoard(); });

// ---- Rating estimate: maximum likelihood over Maia ratings, updated live as chunks arrive ----
const HI_EST_RATINGS = Array.from({ length: 6 }, (_, i) => 600 + i * 400);
const HI_EST_PER_SIDE = 20;
const HI_EST_CHUNK = 10;
const HI_EST_COLORS = { white: "#e8e8e8", black: "#e68f00" };
const HI_EST_MIN_MOVES = 6;

const est = {
  btn: document.getElementById("hiEstimateBtn"),
  status: document.getElementById("hiEstimateStatus"),
  box: document.getElementById("hiEstimate"),
  cards: document.getElementById("hiEstimateCards"),
  chart: document.getElementById("hiEstimateChart"),
  legend: document.getElementById("hiEstimateLegend"),
};
est.cards.className = "hiCards";
let estRun = 0;
let estRunning = false;

function estReset() {
  estRun++;
  estRunning = false;
  est.btn.textContent = "Estimate from this game";
  est.status.textContent = "";
  est.box.style.display = "none";
}

function estSide(ply) {
  const startsBlack = loadedGame.startFen.split(" ")[1] === "b";
  return (ply + (startsBlack ? 1 : 0)) % 2 === 0 ? "white" : "black";
}

// A coarse grid is enough because the curve is smooth: local parabola through the three nearest points.
function estAt(ll, r) {
  const step = HI_EST_RATINGS[1] - HI_EST_RATINGS[0];
  const f = Math.min(Math.max((r - HI_EST_RATINGS[0]) / step, 0), ll.length - 1);
  const j = Math.min(Math.max(Math.round(f), 1), ll.length - 2);
  const t = f - j;
  return ll[j] + t * (ll[j + 1] - ll[j - 1]) / 2 + t * t * (ll[j + 1] - 2 * ll[j] + ll[j - 1]) / 2;
}

// The interval is the 95% likelihood-ratio cut: everything within 1.92 log-units of the best.
function estFit(ll) {
  const lo = HI_EST_RATINGS[0], top = HI_EST_RATINGS[HI_EST_RATINGS.length - 1];
  let peak = lo, best = -Infinity;
  for (let r = lo; r <= top; r += 5) {
    const v = estAt(ll, r);
    if (v > best) { best = v; peak = r; }
  }
  let low = top, high = lo;
  for (let r = lo; r <= top; r += 10) {
    if (estAt(ll, r) >= best - 1.92) { low = Math.min(low, r); high = Math.max(high, r); }
  }
  return { rating: Math.round(peak / 10) * 10, low, high };
}

// Evenly spread over each player's moves so a long game doesn't cost more than a short one.
function estPickPlies(total) {
  const first = total > 30 ? 6 : 0;
  const bySide = { white: [], black: [] };
  for (let ply = first; ply < total; ply++) bySide[estSide(ply)].push(ply);

  const picked = [];
  for (const list of Object.values(bySide)) {
    if (list.length <= HI_EST_PER_SIDE) { picked.push(...list); continue; }
    for (let k = 0; k < HI_EST_PER_SIDE; k++) picked.push(list[Math.round((k * (list.length - 1)) / (HI_EST_PER_SIDE - 1))]);
  }
  return picked.sort((a, b) => a - b);
}

function estRenderCards(fits, counts) {
  est.cards.textContent = "";
  for (const side of ["white", "black"]) {
    const card = document.createElement("div");
    card.className = "hiCard";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = side === "white" ? "White" : "Black";
    const rating = document.createElement("div");
    rating.className = "rating";
    const sub = document.createElement("div");
    sub.className = "sub";

    if (counts[side] < HI_EST_MIN_MOVES) {
      rating.textContent = "—";
      sub.textContent = `${counts[side]} moves so far`;
    } else {
      const f = fits[side];
      const edge = (v) => (v <= HI_EST_RATINGS[0] ? `≤${v}` : v >= HI_EST_RATINGS[HI_EST_RATINGS.length - 1] ? `${v}+` : `${v}`);
      rating.textContent = `~${f.rating}`;
      sub.textContent = `${edge(f.low)}–${edge(f.high)} · ${counts[side]} moves`;
    }
    card.append(who, rating, sub);
    est.cards.appendChild(card);
  }
}

function estRenderChart(ll, counts) {
  const W = 320, H = 130, L = 8, R = 8, T = 8, B = 20;
  const svg = est.chart;
  svg.textContent = "";
  est.legend.textContent = "";

  const lo = HI_EST_RATINGS[0], hiR = HI_EST_RATINGS[HI_EST_RATINGS.length - 1];
  const x = (r) => L + ((r - lo) / (hiR - lo)) * (W - L - R);
  const y = (v) => T + (1 - v) * (H - T - B);

  svgEl("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: "#2c3038", "stroke-width": 1 }, svg);
  for (const r of [600, 1100, 1600, 2100, 2600]) {
    svgEl("text", { x: x(r), y: H - 5, "text-anchor": "middle", "font-size": 9, fill: "#9aa0ab" }, svg).textContent = r;
  }

  for (const side of ["white", "black"]) {
    if (counts[side] < 1) continue;
    const grid = [];
    for (let r = lo; r <= hiR; r += 25) grid.push([r, estAt(ll[side], r)]);
    const peak = Math.max(...grid.map((g) => g[1]));
    const points = grid.map(([r, v]) => `${x(r).toFixed(1)},${y(Math.exp(v - peak)).toFixed(1)}`).join(" ");
    svgEl("polyline", { points, fill: "none", stroke: HI_EST_COLORS[side], "stroke-width": 2, "stroke-linejoin": "round" }, svg);

    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = HI_EST_COLORS[side];
    item.append(swatch, side === "white" ? "White" : "Black");
    est.legend.appendChild(item);
  }
}

async function estStart() {
  if (estRunning) {
    estRun++;
    estRunning = false;
    est.btn.textContent = "Estimate from this game";
    est.status.textContent = "Stopped — showing what was analyzed so far.";
    return;
  }
  if (!loadedGame || !loadedGame.sans.length) return;

  const run = ++estRun;
  estRunning = true;
  est.btn.textContent = "Stop";
  est.status.textContent = "Starting Maia…";
  est.box.style.display = "none";

  try {
    await hiEnsureMaia();
    const ucis = await hiUcis();
    const plies = estPickPlies(ucis.length);
    const ll = { white: HI_EST_RATINGS.map(() => 0), black: HI_EST_RATINGS.map(() => 0) };
    const counts = { white: 0, black: 0 };
    const started = performance.now();

    for (let i = 0; i < plies.length; i += HI_EST_CHUNK) {
      const scored = await invoke("maia_estimate", {
        startFen: loadedGame.startFen,
        ucis,
        plies: plies.slice(i, i + HI_EST_CHUNK),
        ratings: HI_EST_RATINGS,
      });
      if (run !== estRun) return;

      for (const p of scored) {
        const side = estSide(p.ply);
        p.logp.forEach((v, k) => { ll[side][k] += v; });
        counts[side]++;
      }
      est.status.textContent = `Analyzed ${Math.min(i + HI_EST_CHUNK, plies.length)} of ${plies.length} sampled moves…`;
      est.box.style.display = "block";
      estRenderCards({ white: estFit(ll.white), black: estFit(ll.black) }, counts);
      estRenderChart(ll, counts);
    }

    console.debug(`[estimate] ${plies.length} plies ${Math.round(performance.now() - started)}ms`);
    est.status.textContent = counts.white + counts.black < HI_EST_MIN_MOVES
      ? "Not enough non-forced moves to estimate a rating."
      : `Sampled up to ${HI_EST_PER_SIDE} moves per player, assuming both are rated the same. A rough guide.`;
  } catch (err) {
    if (run === estRun) est.status.textContent = "Estimate failed: " + err;
  } finally {
    if (run === estRun) {
      estRunning = false;
      est.btn.textContent = "Estimate from this game";
    }
  }
}

est.btn.addEventListener("click", estStart);

function azFenAt(ply) {
  if (!loadedGame) return STANDARD_FEN;
  return ply === 0 ? loadedGame.startFen : loadedGame.fens[ply - 1];
}
function azLastMoveAt(ply) {
  if (!analysis || ply === 0) return null;
  const m = analysis[ply - 1];
  if (!m || !m.uci) return null;
  return [m.uci.slice(0, 2), m.uci.slice(2, 4)];
}

function analysisArrowsAt(ply) {
  const arrows = [];
  if (!analysis || !az.arrowToggle.checked) return arrows;
  const m = analysis[ply];
  if (!m) return arrows;
  const played = uciToSquares(m.uci);
  if (played && !isPositiveGrade(m.grade)) arrows.push({ from: played[0], to: played[1], brush: "red", opacity: 0.7 });
  const best = uciToSquares(m.bestMoveUci);
  if (best) arrows.push({ from: best[0], to: best[1], brush: "blue" });
  return arrows;
}

function azBadgeAt(ply) {
  if (!analysis || ply === 0) return null;
  const m = analysis[ply - 1];
  const sq = m && m.uci ? m.uci.slice(2, 4) : null;
  return sq ? { square: sq, grade: m.grade } : null;
}

function fenKey(fen) { return fen.split(" ").slice(0, 4).join(" "); }

// Blue for the engine; purple belongs to the human-insight arrows.
const ENG_ARROW_OPACITY = [0.85, 0.55, 0.35];
function engineArrow(fen) {
  if (!eng.enable.checked || !eng.arrows.checked || !az.arrowToggle.checked) return [];
  if (puzzleMode && !puzzleLocked) return [];
  if (!engLive || engLive.key !== fenKey(fen)) return [];
  const out = [];
  engLive.lines.forEach((line, i) => {
    const sq = uciToSquares(line.ucis && line.ucis[0]);
    if (sq && !out.some((x) => x.from === sq[0] && x.to === sq[1])) {
      out.push({ from: sq[0], to: sq[1], brush: "blue", opacity: ENG_ARROW_OPACITY[i] ?? 0.3 });
    }
  });
  return out;
}

function analyzeView() {
  if (variation) {
    // idx 0 previews the first move; after that the arrow marks the move just played
    const sq = uciToSquares(variation.idx > 0 ? variation.ucis[variation.idx - 1] : variation.ucis[0]);
    const fen = variation.fens[variation.idx];
    return {
      fen,
      lastMove: variation.idx > 0 ? sq : null,
      arrows: variation.free
        ? engineArrow(fen)
        : sq && az.arrowToggle.checked ? [{ from: sq[0], to: sq[1], brush: "blue" }] : [],
      badge: null,
    };
  }
  const fen = azFenAt(azViewPly);
  const arrows = analysisArrowsAt(azViewPly).concat(hiArrowsAt(azViewPly));
  for (const a of engineArrow(fen)) {
    if (!arrows.some((x) => x.from === a.from && x.to === a.to)) arrows.push(a);
  }
  return {
    fen,
    lastMove: azLastMoveAt(azViewPly),
    arrows,
    badge: azBadgeAt(azViewPly),
  };
}

function renderAnalyzeBoard() {
  const view = analyzeView();
  renderMaterialBars(az.materialTop, az.materialBottom, view.fen, azFlipped);
  if (azSelFen !== view.fen) { azSelected = null; azTargets = []; }
  const mover = sideToMove(view.fen);
  renderChessBoard(az.board, view.fen, {
    interactive: true,
    flipped: azFlipped,
    lastMove: view.lastMove,
    arrows: view.arrows,
    badge: view.badge,
    selected: azSelected,
    legalTargets: azTargets,
    canDrag: (piece) => isPieceOfColor(piece, mover),
    onGrab: onAzSquareClick,
    onSquareClick: onAzSquareClick,
    onDeselect: () => { azSelected = null; azTargets = []; renderAnalyzeBoard(); },
    onDropMove: (from, to) => {
      if (azSelected === from && azTargets.length > 0 && !azTargets.includes(to)) {
        renderAnalyzeBoard();
        return;
      }
      azSelected = null;
      azTargets = [];
      attemptAzMove(from, to);
    },
  });

  let atStart, atEnd;
  if (variation) {
    atStart = variation.idx === 0;
    atEnd = variation.idx >= variation.fens.length - 1;
  } else {
    const maxPly = loadedGame ? loadedGame.sans.length : 0;
    atStart = azViewPly === 0;
    atEnd = azViewPly >= maxPly;
  }
  az.navStart.disabled = atStart;
  az.navPrev.disabled = atStart;
  az.navNext.disabled = atEnd;
  az.navEnd.disabled = atEnd;
  az.variationBar.style.display = variation ? "flex" : "none";
  syncLineHighlights();
  highlightCurrentMove();
  drawEvalGraph();
  hiRefresh();
  engRefresh();
}

function azGo(where) {
  if (puzzleMode) return;
  if (variation) {
    const last = variation.fens.length - 1;
    if (where === "start") variation.idx = 0;
    else if (where === "end") variation.idx = last;
    else variation.idx = Math.max(0, Math.min(last, variation.idx + (where === "prev" ? -1 : 1)));
  } else {
    const maxPly = loadedGame ? loadedGame.sans.length : 0;
    if (where === "start") azViewPly = 0;
    else if (where === "end") azViewPly = maxPly;
    else azViewPly = Math.max(0, Math.min(maxPly, azViewPly + (where === "prev" ? -1 : 1)));
  }
  renderAnalyzeBoard();
}
az.navStart.addEventListener("click", () => azGo("start"));
az.navPrev.addEventListener("click", () => azGo("prev"));
az.navNext.addEventListener("click", () => azGo("next"));
az.navEnd.addEventListener("click", () => azGo("end"));

function azGoToPly(ply) {
  if (puzzleMode) return;
  variation = null;
  azViewPly = ply;
  renderAnalyzeBoard();
}

async function onAzSquareClick(sq) {
  if (puzzleMode) return;
  const fen = analyzeView().fen;
  const mover = sideToMove(fen);
  const isOwn = isPieceOfColor(fenToBoard(fen)[sq], mover);

  if (azSelected && azTargets.includes(sq)) {
    const from = azSelected;
    azSelected = null;
    azTargets = [];
    await attemptAzMove(from, sq);
    return;
  }
  if (isOwn) {
    if (azSelected === sq) return;
    azSelected = sq;
    azTargets = [];
    azSelFen = fen;
    renderAnalyzeBoard();
    let targets = [];
    try { targets = await invoke("scratch_legal_targets", { fen, square: sq }); } catch { targets = []; }
    if (azSelected !== sq || analyzeView().fen !== fen) return;
    azTargets = targets;
    renderAnalyzeBoard();
    return;
  }
  azSelected = null;
  azTargets = [];
  renderAnalyzeBoard();
}

async function attemptAzMove(from, to) {
  const fen = analyzeView().fen;
  let promotion = null;
  if (needsPromotionMove(fen, from, to)) {
    promotion = await askPromotion(az.promo, sideToMove(fen) === "white" ? "w" : "b");
    if (!promotion) { renderAnalyzeBoard(); return; }
  }
  let result;
  try {
    result = await invoke("scratch_try_move", { fen, from, to, promotion });
  } catch {
    renderAnalyzeBoard();
    return;
  }
  if (analyzeView().fen !== fen) return;
  playFreeMove(fen, result);
}

function setFreeVariation(v) {
  v.free = true;
  v.ply = -1;
  v.m = { fenBefore: v.fens[0], bestLineSan: v.sans };
  variation = v;
  az.variationTitle.textContent = "Your line — move a piece to branch off";
  renderLineChips(az.variationLine, v.m, (n) => { v.idx = n; renderAnalyzeBoard(); });
  renderAnalyzeBoard();
}

function playFreeMove(fen, mv) {
  let v;
  if (!variation) {
    v = { fens: [fen], ucis: [], sans: [], idx: 0 };
  } else {
    // an engine-line preview becomes the user's own line from the current point
    const sans = variation.sans || (variation.m && variation.m.bestLineSan) || [];
    v = {
      fens: variation.fens.slice(0, variation.idx + 1),
      ucis: variation.ucis.slice(0, variation.idx),
      sans: sans.slice(0, variation.idx),
      idx: variation.idx,
    };
    // playing the move already on the board just steps forward
    if (variation.ucis[variation.idx] === mv.uci) {
      v = { fens: variation.fens.slice(), ucis: variation.ucis.slice(), sans: sans.slice(), idx: variation.idx + 1 };
      setFreeVariation(v);
      return;
    }
  }
  v.fens.push(mv.fen);
  v.ucis.push(mv.uci);
  v.sans.push(mv.san);
  v.idx = v.fens.length - 1;
  setFreeVariation(v);
}

function startEngineLine(fen, line, n) {
  setFreeVariation({ fens: [fen].concat(line.fens), ucis: line.ucis.slice(), sans: line.sans.slice(), idx: n });
}

function formatEngineEval(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate === 0 ? "#" : `#${line.mate}`;
  const pawns = (line.scoreCp || 0) / 100;
  return (pawns > 0 ? "+" : "") + pawns.toFixed(2);
}

function engineSideAhead(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate >= 0 ? "white" : "black";
  return (line.scoreCp || 0) >= 0 ? "white" : "black";
}

// Share of the bar given to White, using the same curve as the grading.
function engineWhiteShare(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate >= 0 ? 100 : 0;
  return 100 / (1 + Math.exp(-0.004 * (line.scoreCp || 0)));
}

// The position the board is showing right now, in analysis or practice mode.
function engPosition() {
  if (!puzzleMode) return analyzeView().fen;
  return puzzleCurFen();
}

function redrawBoardForEngine() {
  if (puzzleMode) renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  else renderAnalyzeBoard();
}

function engMessage(text) {
  eng.note.textContent = text;
}

function renderEngineLines(fen, lines) {
  eng.list.textContent = "";
  lines.forEach((line) => {
    const row = document.createElement("div");
    row.className = "engLine";
    const chip = document.createElement("span");
    chip.className = `engChip ${engineSideAhead(line)}`;
    chip.textContent = formatEngineEval(line);
    const moves = document.createElement("span");
    moves.className = "lineMoves";
    renderLineChips(moves, { fenBefore: fen, bestLineSan: line.sans }, (n) => {
      if (puzzleMode) startPuzzleEngineLine(line, n);
      else startEngineLine(fen, line, n);
    });
    row.appendChild(chip);
    row.appendChild(moves);
    eng.list.appendChild(row);
  });

  const top = lines[0];
  eng.score.textContent = formatEngineEval(top);
  eng.score.className = `engChip engScore ${engineSideAhead(top)}`;
  eng.barFill.style.width = `${engineWhiteShare(top).toFixed(1)}%`;
}

function engSetStatus(depth, searching) {
  eng.status.textContent = searching ? `depth ${depth}…` : `depth ${depth}`;
  eng.body.classList.toggle("busy", searching);
}

async function engRefresh() {
  if (!eng.enable.checked) {
    engToken++;
    engKey = null;
    engLive = null;
    eng.body.style.display = "none";
    engMessage("");
    return;
  }
  if (puzzleMode && !puzzleLocked) {
    // keeps the answer hidden until the puzzle is solved or revealed
    engToken++;
    engKey = null;
    engLive = null;
    eng.body.style.display = "none";
    engMessage("The engine unlocks once you solve the puzzle or reveal the answer.");
    return;
  }
  if (analyzingGame) {
    engToken++;
    engKey = null;
    engMessage("Waiting for the game analysis to finish…");
    return;
  }

  const fen = engPosition();
  const target = ENG_DEPTH;
  const count = parseInt(eng.lines.value, 10);
  const key = `${fenKey(fen)}|${target}|${count}`;
  if (key === engKey) return;
  engKey = key;
  const token = ++engToken;

  const cached = engCache.get(key);
  if (cached) {
    engLive = { key: fenKey(fen), lines: cached };
    showEngineResult(fen, cached, target, target, token);
    return;
  }

  const seed = engSeed.get(fenKey(fen));
  if (seed && seed.depth >= target && seed.lines.length >= count) {
    engCache.set(key, seed.lines);
    engLive = { key: fenKey(fen), lines: seed.lines };
    showEngineResult(fen, seed.lines, target, target, token);
    return;
  }
  if (seed) {
    engLive = { key: fenKey(fen), lines: seed.lines };
    showEngineResult(fen, seed.lines, seed.depth, target, token);
  } else if (eng.body.style.display === "none") engMessage("Thinking…");
  else eng.body.classList.add("busy");
  await new Promise((r) => setTimeout(r, ENG_DEBOUNCE_MS));
  if (token !== engToken) return;

  if (!(await ensureStockfish())) {
    if (token === engToken) engMessage(az.analyzeStatus.textContent);
    return;
  }

  const depths = target > 10 && !(seed && seed.depth >= 10) ? [10, target] : [target];
  for (const depth of depths) {
    if (token !== engToken) return;
    let lines;
    try {
      lines = await invoke("engine_lines", { fen, depth, multipv: count });
    } catch (err) {
      if (token === engToken) {
        eng.body.style.display = "none";
        engMessage("Engine failed: " + err);
      }
      return;
    }
    if (token !== engToken) return;
    engLive = { key: fenKey(fen), lines };
    if (depth === target) engCache.set(key, lines);
    lines.forEach((l) => engSeedLine(fen, l, depth));
    showEngineResult(fen, lines, depth, target, token);
  }
}

function showEngineResult(fen, lines, depth, target, token) {
  if (token !== engToken) return;
  if (!lines.length || !lines[0].ucis.length) {
    eng.body.style.display = "none";
    engMessage("No moves to analyze here — the game is over.");
    return;
  }
  engMessage("");
  eng.body.style.display = "block";
  renderEngineLines(fen, lines);
  engSetStatus(depth, depth < target);
  // arrows depend on the result; the key guard stops this from restarting the search
  redrawBoardForEngine();
}

eng.enable.addEventListener("change", () => { engKey = null; engRefresh(); if (!eng.enable.checked) redrawBoardForEngine(); });
eng.lines.addEventListener("change", () => { engKey = null; engRefresh(); });
eng.arrows.addEventListener("change", redrawBoardForEngine);

az.arrowToggle.addEventListener("change", () => { if (!puzzleMode) renderAnalyzeBoard(); });
az.variationExitBtn.addEventListener("click", () => { variation = null; renderAnalyzeBoard(); });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (!document.getElementById("analyzeTab").classList.contains("active")) return;
  if (e.target.closest && e.target.closest("input, textarea, select, summary")) return;

  const navTargets = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end" };
  if (e.key in navTargets) {
    e.preventDefault();
    if (puzzleMode) goPuzzleLine(navTargets[e.key]);
    else azGo(navTargets[e.key]);
    return;
  }
  if (e.key === "Escape") {
    if (variation) {
      e.preventDefault();
      variation = null;
      renderAnalyzeBoard();
    } else if (puzzleMode) {
      e.preventDefault();
      exitPuzzleMode();
    }
    return;
  }
  if (e.key.toLowerCase() === "f" && !puzzleMode) {
    e.preventDefault();
    az.flipBtn.click();
  }
});

// onPick(n): n = moves played from the start of the line
function renderLineChips(container, entry, onPick) {
  container.textContent = "";
  const parts = entry.fenBefore.split(" ");
  let white = parts[1] !== "b";
  let num = parseInt(parts[5], 10) || 1;
  (entry.bestLineSan || []).forEach((san, i) => {
    if (white || i === 0) {
      const n = document.createElement("span");
      n.className = "lineNum";
      n.textContent = white ? `${num}.` : `${num}...`;
      container.appendChild(n);
    }
    const chip = document.createElement("span");
    chip.className = "lineMove";
    chip.dataset.idx = String(i + 1);
    chip.textContent = san;
    chip.title = "Show this position on the board";
    chip.addEventListener("click", (e) => { e.stopPropagation(); onPick(i + 1); });
    container.appendChild(chip);
    if (!white) num += 1;
    white = !white;
  });
}

function setActiveChip(container, idx) {
  container.querySelectorAll(".lineMove[data-idx]").forEach((c) => {
    c.classList.toggle("active", c.dataset.idx === String(idx));
  });
}

function hasClickableLine(m) {
  return !!(m && m.bestLineFens && m.bestLineFens.length && m.bestLineUci && m.bestLineUci.length);
}

function startVariation(i, idx) {
  if (puzzleMode || !analysis) return;
  const m = analysis[i];
  if (!hasClickableLine(m)) return;
  variation = {
    ply: i,
    m,
    fens: [m.fenBefore].concat(m.bestLineFens),
    ucis: m.bestLineUci,
    idx: Math.max(0, Math.min(idx, m.bestLineFens.length)),
  };
  azViewPly = i; // exiting the variation returns to where it branched off

  const mover = sideToMove(m.fenBefore);
  const num = Math.floor(i / 2) + 1;
  az.variationTitle.textContent = `Engine line instead of ${mover === "white" ? `${num}.` : `${num}...`} ${m.san}`;
  renderLineChips(az.variationLine, m, (n) => { variation.idx = n; renderAnalyzeBoard(); });
  renderAnalyzeBoard();
}

function syncLineHighlights() {
  az.flaggedList.querySelectorAll(".lineMoves").forEach((box) => {
    setActiveChip(box, variation && String(variation.ply) === box.dataset.ply ? variation.idx : -1);
  });
  if (variation) setActiveChip(az.variationLine, variation.idx);
}

// Puzzle mode orients itself to the side to move, so flipping only shows once you leave it.
az.flipBtn.addEventListener("click", () => {
  azFlipped = !azFlipped;
  if (!puzzleMode) renderAnalyzeBoard();
});

function orientAnalyzeBoardForSide() {
  const side = az.sideSelect.value;
  if (side === "white") azFlipped = false;
  else if (side === "black") azFlipped = true;
}

function loadAnalysisGame(game) {
  loadedGame = game;
  hiResetForGame();
  analysis = null;
  variation = null;
  gradeFilter = null;
  // Games sent from the Play tab know which side the person played; a pasted PGN doesn't, so leave "Both" then.
  az.practiceSideSelect.value = game.myColor === "white" || game.myColor === "black" ? game.myColor : "both";
  azViewPly = game.sans.length;
  az.analyzeBtn.disabled = game.sans.length === 0;
  az.moveListPanel.style.display = "none";
  az.flaggedPanel.style.display = "none";
  az.loadPanel.classList.add("collapsed");
  az.controlsPanel.classList.remove("collapsed");
  az.analyzeStatus.textContent = `Loaded ${game.sans.length} ply. Click "Analyze Game" to grade it.`;
  azFlipped = game.myColor === "white" || game.myColor === "black" ? game.myColor === "black" : az.sideSelect.value === "black";
  renderAnalyzeBoard();
  drawEvalGraph();
  exitPuzzleMode();
}

[az.loadPanel, az.controlsPanel].forEach((panel) => {
  panel.querySelector("h2").addEventListener("click", () => panel.classList.toggle("collapsed"));
});

az.loadBtn.addEventListener("click", async () => {
  az.loadError.textContent = "";
  const text = az.pgnInput.value.trim();
  if (!text) { az.loadError.textContent = "Paste a PGN first."; return; }
  try {
    const parsed = await invoke("parse_pgn", { pgnText: text });
    loadAnalysisGame({ startFen: parsed.startFen, sans: parsed.sans, fens: parsed.fens, ucis: parsed.ucis });
  } catch (err) {
    az.loadError.textContent = String(err);
  }
});

async function ensureStockfish() {
  if (stockfishStarted) return true;
  try {
    if (await invoke("stockfish_running")) {
      stockfishStarted = true;
      return true;
    }

    // No command passed: the backend finds Stockfish itself, since the bare name fails when launched from a desktop menu.
    try {
      await invoke("start_stockfish", {});
    } catch (err) {
      if (!String(err).startsWith("not-found:")) throw err;

      // Not installed, or hidden by the Flatpak sandbox: download a private copy.
      az.analyzeStatus.textContent =
        "Stockfish wasn't found on this system — downloading a copy into the app's own folder…";
      const stop = await listenSetupProgress("stockfish", (p) => {
        az.analyzeStatus.textContent =
          `Downloading Stockfish… ${Math.floor(p.overall)}%` + (p.detail ? ` (${p.detail})` : "");
      });
      try {
        await invoke("install_stockfish");
      } finally {
        stop();
      }
      az.analyzeStatus.textContent = "Starting Stockfish…";
      await invoke("start_stockfish", {});
    }
    stockfishStarted = true;
    return true;
  } catch (err) {
    let msg = String(err).replace(/^not-found:\s*/, "");
    az.analyzeStatus.textContent = "Stockfish isn't available: " + msg;
    return false;
  }
}

az.analyzeBtn.addEventListener("click", async () => {
  if (!loadedGame || loadedGame.sans.length === 0) return;
  az.analyzeBtn.disabled = true;
  az.analyzeStatus.textContent = "Checking Stockfish…";
  const ok = await ensureStockfish();
  if (!ok) { az.analyzeBtn.disabled = false; return; }

  az.analyzeStatus.textContent = "Analyzing… this can take a while at higher depth.";
  analyzingGame = true;
  engRefresh();
  const analysisDepthUsed = parseInt(az.depthSelect.value, 10);
  try {
    analysis = await invoke("analyze_moves", {
      sans: loadedGame.sans,
      startFen: loadedGame.startFen,
      depth: analysisDepthUsed,
      multipv: 5,
    });
    analysisDepth = analysisDepthUsed;
    az.analyzeStatus.textContent = `Analyzed ${analysis.length} moves.`;
    renderAnalyzeMoveList();
    renderFlaggedList();
    drawEvalGraph();
    az.moveListPanel.style.display = "block";
    az.flaggedPanel.style.display = "block";
    az.controlsPanel.classList.add("collapsed");
  } catch (err) {
    az.analyzeStatus.textContent = "Analysis failed: " + err;
  } finally {
    analyzingGame = false;
    az.analyzeBtn.disabled = false;
    engRefresh();
  }
});

function gradeClass(grade) { return "grade-" + grade; }
// no "better move" hint for either — both are already the top choice
function isPositiveGrade(grade) { return ["good", "best", "onlymove", "brilliant"].includes(grade); }

function renderAnalyzeMoveList() {
  az.moveList.innerHTML = "";
  const side = az.sideSelect.value;
  for (let i = 0; i < analysis.length; i++) {
    const m = analysis[i];
    const mover = sideToMove(m.fenBefore);
    if (side !== "both" && side !== mover) continue;

    const row = document.createElement("div");
    row.className = "aMove";
    row.dataset.ply = String(i + 1);
    const num = Math.floor(i / 2) + 1;
    const label = (i % 2 === 0) ? `${num}.` : `${num}...`;
    const left = document.createElement("span");
    left.innerHTML = `<span class="gradeChip ${gradeClass(m.grade)}"></span>${label} ${m.san}`;
    const right = document.createElement("span");
    right.className = gradeClass(m.grade);
    right.textContent = EVAL_GRADE_NAME[m.grade] ?? m.grade;
    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", () => azGoToPly(i + 1));
    az.moveList.appendChild(row);
  }
  if (!az.moveList.children.length) {
    az.moveList.innerHTML = '<div class="emptyHint">No moves for this side.</div>';
  }
}
az.sideSelect.addEventListener("change", () => {
  orientAnalyzeBoardForSide();
  if (analysis) renderAnalyzeMoveList();
  if (!puzzleMode) renderAnalyzeBoard();
});

function highlightCurrentMove() {
  az.moveList.querySelectorAll(".aMove").forEach((row) => {
    row.classList.toggle("current", !variation && row.dataset.ply === String(azViewPly));
  });
}

az.flaggedHeading.addEventListener("click", () => az.flaggedPanel.classList.toggle("listCollapsed"));

function renderFlaggedList() {
  az.flaggedList.innerHTML = "";
  const flagged = analysis
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.grade === "mistake" || m.grade === "blunder");
  // folded by default; the practice button below it stays visible
  az.flaggedPanel.classList.add("listCollapsed");
  az.flaggedCount.textContent = flagged.length ? `(${flagged.length})` : "";

  if (flagged.length === 0) {
    az.flaggedList.innerHTML = '<div class="emptyHint">No mistakes or blunders flagged — nice game!</div>';
    az.practiceBtn.style.display = "none";
    az.practiceSideRow.style.display = "none";
    return;
  }

  for (const { m, i } of flagged) {
    const num = Math.floor(i / 2) + 1;
    const mover = sideToMove(m.fenBefore);
    const label = mover === "white" ? `${num}.` : `${num}...`;
    const clickable = hasClickableLine(m);
    const div = document.createElement("div");
    div.className = "flaggedItem";

    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = `<span class="sideTag ${mover}">${mover === "white" ? "White" : "Black"}</span> `
      + `<span class="${gradeClass(m.grade)}">${label} ${m.san} (${m.grade})</span>`;
    div.appendChild(head);

    const better = document.createElement("div");
    if (m.bestMoveSan) {
      better.appendChild(document.createTextNode("— better was "));
      const b = document.createElement(clickable ? "span" : "b");
      b.textContent = m.bestMoveSan;
      if (clickable) {
        b.className = "lineMove bestMove";
        b.title = "Show the better move on the board";
        b.addEventListener("click", (e) => { e.stopPropagation(); startVariation(i, 1); });
      }
      better.appendChild(b);
    }
    div.appendChild(better);

    if (m.bestLineSan && m.bestLineSan.length) {
      const line = document.createElement("div");
      line.className = "line lineMoves";
      line.dataset.ply = String(i);
      if (clickable) renderLineChips(line, m, (n) => startVariation(i, n));
      else line.textContent = m.bestLineSan.join(" ");
      div.appendChild(line);
    }

    div.addEventListener("click", () => azGoToPly(i + 1));
    az.flaggedList.appendChild(div);
  }

  updatePracticeControls();
}

let allPuzzles = [];
let puzzles = [];
function updatePracticeControls() {
  allPuzzles = analysis
    .filter((m) => (m.grade === "mistake" || m.grade === "blunder") && m.bestMoveUci);
  const side = az.practiceSideSelect.value;
  puzzles = allPuzzles.filter((m) => side === "both" || sideToMove(m.fenBefore) === side);
  if (allPuzzles.length === 0) {
    az.practiceSideRow.style.display = "none";
    az.practiceBtn.style.display = "none";
    return;
  }
  az.practiceSideRow.style.display = "flex";
  az.practiceBtn.style.display = "inline-block";
  az.practiceBtn.disabled = puzzles.length === 0;
  az.practiceBtn.textContent = puzzles.length > 0
    ? `Practice My Mistakes (${puzzles.length}) →` : "No mistakes for this side";
}
az.practiceSideSelect.addEventListener("change", () => {
  updatePracticeControls();
  if (!puzzleMode) return;
  if (puzzles.length > 0) enterPuzzleMode(); else exitPuzzleMode();
});
az.practiceBtn.addEventListener("click", enterPuzzleMode);

// Eval graph: Y axis is win probability (Lichess curve); linear centipawns would flatten most games near zero.
const EVAL_GRADE_COLORS = { brilliant: "#26c2c2", onlymove: "#5b9bd5", inaccuracy: "#e3c96b", mistake: "#f0a860", blunder: "#e05555" };
const EVAL_GRADE_RADIUS = { brilliant: 5, onlymove: 4.5, inaccuracy: 3.5, mistake: 4.5, blunder: 5.5 };
const EVAL_GRADE_MARK = { good: "", best: "", onlymove: "!", brilliant: "!!", inaccuracy: "?!", mistake: "?", blunder: "??" };
const EVAL_GRADE_NAME = { good: "Good", best: "Best", onlymove: "Only move", brilliant: "Brilliant", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" };
let evalHoverPly = null;
let evalDragging = false;
let evalGeom = null;       // { left, plotW, n } from the last draw, for hit-testing

// White's point of view in centipawns, clamped; mates pin to the edge.
function evalWhiteCp(cp, mate) {
  if (typeof cp === "number") return Math.max(-3000, Math.min(3000, cp));
  if (typeof mate === "number") return mate > 0 ? 3000 : mate < 0 ? -3000 : 0;
  return 0;
}
function evalWinPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
// "+1.25", "−0.40", "#3" (White mates in 3), "−#2" (Black mates in 2)
function evalLabel(cp, mate) {
  if (typeof cp !== "number") {
    if (typeof mate !== "number") return "?";
    return (mate < 0 ? "−" : "") + "#" + Math.abs(mate);
  }
  const v = cp / 100;
  const t = Math.abs(v).toFixed(2);
  return v > 0 ? "+" + t : v < 0 ? "−" + t : "0.00";
}

// Follows the "Grade whose moves" selector, same as the move list.
let gradeFilter = null; // which legend button is "active" for cycling; doesn't hide anything
function evalMoveVisible(m) {
  if (puzzleMode) return puzzles.includes(m);
  const side = az.sideSelect.value;
  return side === "both" || sideToMove(m.fenBefore) === side;
}

// Indices of moves of grade `g` that the "Grade whose moves" selector currently includes, in play order.
function gradeMatches(g) {
  return analysis.reduce((acc, m, i) => { if (m.grade === g && evalMoveVisible(m)) acc.push(i); return acc; }, []);
}

function evalCursorPly() {
  if (puzzleMode && puzzles[puzzleIndex]) return Math.max(0, analysis.indexOf(puzzles[puzzleIndex]));
  return azViewPly;
}

function selectPuzzleNearPly(ply) {
  if (ply === null || puzzles.length === 0) return;
  let best = puzzleIndex, bestDist = Infinity;
  puzzles.forEach((p, i) => {
    const d = Math.abs(analysis.indexOf(p) + 1 - ply); // dots sit one ply after the mistake
    if (d < bestDist) { bestDist = d; best = i; }
  });
  if (best === puzzleIndex) return;
  puzzleIndex = best;
  loadPuzzle(true);
}

// Jumps to the next move of this grade after the position on screen, wrapping back to the first.
function jumpToGrade(g) {
  const matches = gradeMatches(g);
  if (matches.length === 0) return;
  if (puzzleMode) {
    const cur = evalCursorPly();
    const next = matches.find((i) => i > cur);
    const target = analysis[next === undefined ? matches[0] : next];
    const idx = puzzles.indexOf(target);
    if (idx >= 0 && idx !== puzzleIndex) { puzzleIndex = idx; loadPuzzle(true); }
    return;
  }
  gradeFilter = g;
  const next = matches.find((i) => i + 1 > azViewPly);
  variation = null;
  azViewPly = next === undefined ? matches[0] + 1 : next + 1;
  renderAnalyzeBoard();
}

function drawEvalGraph() {
  const svg = az.evalGraph;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!analysis || analysis.length === 0) {
    az.evalBox.style.display = "none";
    evalGeom = null;
    return;
  }
  az.evalBox.style.display = "block";

  const W = Math.round(svg.clientWidth);
  const H = Math.round(svg.clientHeight);
  if (W < 80 || H < 40) return; // not laid out yet; the ResizeObserver redraws
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const n = analysis.length;
  const curPly = evalCursorPly();
  const left = 30, right = 10, top = 10, bottom = 20;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const mid = top + plotH / 2;
  const xAt = (ply) => left + (n === 0 ? 0 : (ply / n) * plotW);
  const yAt = (cp) => top + plotH * (1 - evalWinPct(cp) / 100);
  evalGeom = { left, plotW, n };

  const cps = [evalWhiteCp(analysis[0].evalBeforeCp, analysis[0].mateBefore)]
    .concat(analysis.map((m) => evalWhiteCp(m.evalAfterCp, m.mateAfter)));
  const pts = cps.map((cp, i) => [xAt(i), yAt(cp)]);

  for (const [cp, label] of [[300, "+3"], [100, "+1"], [0, "0"], [-100, "−1"], [-300, "−3"]]) {
    const y = yAt(cp);
    svgEl("line", {
      x1: left, x2: left + plotW, y1: y, y2: y,
      stroke: cp === 0 ? "#5a5f6b" : "rgba(255,255,255,0.08)",
      "stroke-width": 1, "stroke-dasharray": cp === 0 ? "" : "2 3",
    }, svg);
    const t = svgEl("text", {
      x: left - 6, y: y + 3, "text-anchor": "end", "font-size": 9.5, fill: "#7d8390",
    }, svg);
    t.textContent = label;
  }

  const moves = n / 2;
  const step = moves <= 10 ? 2 : moves <= 30 ? 5 : moves <= 60 ? 10 : 20;
  for (let mv = step; mv * 2 <= n; mv += step) {
    const x = xAt(mv * 2);
    svgEl("line", { x1: x, x2: x, y1: top + plotH, y2: top + plotH + 3, stroke: "#5a5f6b" }, svg);
    const t = svgEl("text", {
      x, y: H - 5, "text-anchor": "middle", "font-size": 9.5, fill: "#7d8390",
    }, svg);
    t.textContent = String(mv);
  }

  const defs = svgEl("defs", {}, svg);
  const clipUp = svgEl("clipPath", { id: "evalClipUp" }, defs);
  svgEl("rect", { x: left, y: top, width: plotW, height: mid - top }, clipUp);
  const clipDown = svgEl("clipPath", { id: "evalClipDown" }, defs);
  svgEl("rect", { x: left, y: mid, width: plotW, height: top + plotH - mid }, clipDown);
  const areaD =
    `M${pts[0][0].toFixed(1)},${mid} ` +
    pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") +
    ` L${pts[pts.length - 1][0].toFixed(1)},${mid} Z`;
  svgEl("path", { d: areaD, fill: "rgba(231,233,238,0.65)", "clip-path": "url(#evalClipUp)" }, svg);
  svgEl("path", { d: areaD, fill: "rgba(0,0,0,0.55)", "clip-path": "url(#evalClipDown)" }, svg);

  svgEl("polyline", {
    points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "),
    fill: "none", stroke: "#8fb0ff", "stroke-width": 1.8,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }, svg);

  if (evalHoverPly !== null && evalHoverPly !== curPly) {
    svgEl("line", {
      x1: xAt(evalHoverPly), x2: xAt(evalHoverPly), y1: top, y2: top + plotH,
      stroke: "rgba(255,255,255,0.35)", "stroke-width": 1,
    }, svg);
  }

  const cx = xAt(curPly);
  svgEl("line", {
    x1: cx, x2: cx, y1: top, y2: top + plotH, stroke: "#5a86f5", "stroke-width": 1.5,
  }, svg);

  // Drawn last so the dots sit on top.
  for (let i = 0; i < n; i++) {
    const m = analysis[i];
    const color = EVAL_GRADE_COLORS[m.grade];
    if (!color || !evalMoveVisible(m)) continue;
    const [x, y] = pts[i + 1];
    const r = EVAL_GRADE_RADIUS[m.grade];
    const isCurPuzzle = puzzleMode && puzzles[puzzleIndex] === m;
    if (isCurPuzzle || i + 1 === curPly || i + 1 === evalHoverPly) {
      svgEl("circle", { cx: x, cy: y, r: r + 3.5, fill: "none", stroke: "#fff", "stroke-width": 1.5 }, svg);
    }
    svgEl("circle", { cx: x, cy: y, r, fill: color, stroke: "#16181d", "stroke-width": 1.5 }, svg);
  }
  const curMove = curPly > 0 ? analysis[curPly - 1] : null;
  if (!curMove || !EVAL_GRADE_COLORS[curMove.grade] || !evalMoveVisible(curMove)) {
    const [x, y] = pts[curPly];
    svgEl("circle", { cx: x, cy: y, r: 3.5, fill: "#fff", stroke: "#5a86f5", "stroke-width": 2 }, svg);
  }

  renderEvalInfo(evalHoverPly !== null ? evalHoverPly : curPly);
  renderEvalLegend();
}

function renderEvalInfo(ply) {
  const box = az.evalInfo;
  box.textContent = "";
  const add = (text, cls) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    box.appendChild(s);
    return s;
  };

  if (ply === 0) {
    add("Start position", "evalMove");
    add(` · eval ${evalLabel(analysis[0].evalBeforeCp, analysis[0].mateBefore)}`, "evalMuted");
    return;
  }
  const m = analysis[ply - 1];
  const num = Math.floor((ply - 1) / 2) + 1;
  const label = (ply - 1) % 2 === 0 ? `${num}.` : `${num}...`;
  add(`${label} ${m.san}${EVAL_GRADE_MARK[m.grade]}`, "evalMove");
  add(` ${EVAL_GRADE_NAME[m.grade]}`, gradeClass(m.grade));

  const before = evalLabel(m.evalBeforeCp, m.mateBefore);
  const after = evalLabel(m.evalAfterCp, m.mateAfter);
  add(` · eval ${before === after ? after : `${before} → ${after}`}`, "evalMuted");

  if (!puzzleMode && !isPositiveGrade(m.grade) && m.bestMoveSan) {
    add(" · better: ", "evalMuted");
    const b = document.createElement(hasClickableLine(m) ? "span" : "b");
    b.textContent = m.bestMoveSan;
    if (hasClickableLine(m)) {
      b.className = "lineMove bestMove";
      b.title = "Show the better move on the board";
      b.addEventListener("click", (e) => { e.stopPropagation(); startVariation(ply - 1, 1); });
    }
    box.appendChild(b);
  }

  az.evalLine.textContent = "";
  if (!puzzleMode && !isPositiveGrade(m.grade) && hasClickableLine(m)) {
    renderLineChips(az.evalLine, m, (n) => startVariation(ply - 1, n));
    az.evalLine.dataset.ply = String(ply - 1);
  }
}

function renderEvalLegend() {
  az.evalLegend.textContent = "";
  const GRADE_NOUN_PLURAL = { brilliant: "brilliant moves", onlymove: "only moves", inaccuracy: "inaccuracies", mistake: "mistakes", blunder: "blunders" };
  const GRADE_NOUN_SINGULAR = { brilliant: "brilliant move", onlymove: "only move", inaccuracy: "inaccuracy", mistake: "mistake", blunder: "blunder" };
  for (const g of ["brilliant", "onlymove", "inaccuracy", "mistake", "blunder"]) {
    const matches = gradeMatches(g);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "evalLegendItem";
    item.classList.toggle("active", gradeFilter === g);
    item.disabled = matches.length === 0;
    const dot = document.createElement("span");
    dot.className = "evalLegendDot";
    dot.style.background = EVAL_GRADE_COLORS[g];
    item.appendChild(dot);
    const noun = matches.length === 1 ? GRADE_NOUN_SINGULAR[g] : GRADE_NOUN_PLURAL[g];
    item.appendChild(document.createTextNode(`${matches.length} ${noun}`));
    item.title = matches.length ? `Jump to the next ${EVAL_GRADE_NAME[g].toLowerCase()}` : "";
    item.addEventListener("click", () => jumpToGrade(g));
    az.evalLegend.appendChild(item);
  }
}

function evalPlyFromEvent(e) {
  if (!analysis || !evalGeom) return null;
  const rect = az.evalGraph.getBoundingClientRect();
  const frac = (e.clientX - rect.left - evalGeom.left) / evalGeom.plotW;
  return Math.max(0, Math.min(evalGeom.n, Math.round(frac * evalGeom.n)));
}
function evalSeek(ply) {
  if (ply === null) return;
  if (puzzleMode) { selectPuzzleNearPly(ply); return; }
  if (ply === azViewPly && !variation) return;
  variation = null;
  azViewPly = ply;
  renderAnalyzeBoard();
}
az.evalGraph.addEventListener("pointerdown", (e) => {
  if (!analysis) return;
  evalDragging = true;
  az.evalGraph.setPointerCapture(e.pointerId);
  evalHoverPly = evalPlyFromEvent(e);
  evalSeek(evalHoverPly);
});
az.evalGraph.addEventListener("pointermove", (e) => {
  if (!analysis) return;
  const p = evalPlyFromEvent(e);
  if (evalDragging) evalSeek(p);
  if (p !== evalHoverPly) {
    evalHoverPly = p;
    drawEvalGraph();
  }
});
const evalPointerDone = () => { evalDragging = false; };
az.evalGraph.addEventListener("pointerup", evalPointerDone);
az.evalGraph.addEventListener("pointercancel", evalPointerDone);
az.evalGraph.addEventListener("pointerleave", () => {
  if (evalDragging) return;
  evalHoverPly = null;
  if (analysis) drawEvalGraph();
});
// Also fires when the Analyze tab first becomes visible.
new ResizeObserver(() => drawEvalGraph()).observe(az.evalGraph);

// ---- Puzzle mode ----
let puzzleMode = false;
let puzzleIndex = 0;
let puzzleHomeIndex = 0;
let puzzleSolved = 0;
let puzzleLocked = false;
let puzzleFen = null;
let puzzleSelected = null;
let puzzleLegalTargets = [];
let puzzleViewIdx = 0;
// Line explored after solving: starts as the solution, branches when you move a piece.
let puzzleExp = null;

function puzzleCurFen() {
  return puzzleLocked && puzzleExp ? puzzleExp.fens[puzzleViewIdx] : puzzleFen;
}

function lockPuzzle(puzzle) {
  puzzleLocked = true;
  puzzleSelected = null;
  puzzleLegalTargets = [];
  puzzleViewIdx = 0;
  const clickable = hasClickableLine(puzzle);
  if (analysisDepth && puzzle && puzzle.bestLineUci && puzzle.bestLineUci.length &&
      (puzzle.evalBeforeCp !== null && puzzle.evalBeforeCp !== undefined)) {
    engSeedLine(puzzleFen, {
      scoreCp: puzzle.evalBeforeCp, mate: puzzle.mateBefore ?? null,
      sans: puzzle.bestLineSan || [], ucis: puzzle.bestLineUci, fens: puzzle.bestLineFens || [],
    }, analysisDepth);
  }
  puzzleExp = {
    fens: [puzzleFen].concat(clickable ? puzzle.bestLineFens : []),
    ucis: clickable ? puzzle.bestLineUci.slice() : [],
    sans: clickable ? (puzzle.bestLineSan || []).slice() : [],
  };
}

function refreshPuzzleChips() {
  const moves = az.puzzleFeedback.querySelector(".puzzleLine .lineMoves");
  if (!moves || !puzzleExp) return;
  renderLineChips(moves, { fenBefore: puzzleFen, bestLineSan: puzzleExp.sans }, (n) => {
    puzzleViewIdx = n;
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  });
  setActiveChip(moves, puzzleViewIdx);
}

function playPuzzleFreeMove(mv) {
  const e = puzzleExp, i = puzzleViewIdx;
  if (e.ucis[i] !== mv.uci) {
    e.fens = e.fens.slice(0, i + 1).concat(mv.fen);
    e.ucis = e.ucis.slice(0, i).concat(mv.uci);
    e.sans = e.sans.slice(0, i).concat(mv.san);
  }
  puzzleViewIdx = i + 1;
  refreshPuzzleChips();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function startPuzzleEngineLine(line, n) {
  const e = puzzleExp, i = puzzleViewIdx;
  e.fens = e.fens.slice(0, i + 1).concat(line.fens);
  e.ucis = e.ucis.slice(0, i).concat(line.ucis);
  e.sans = e.sans.slice(0, i).concat(line.sans);
  puzzleViewIdx = i + n;
  refreshPuzzleChips();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function isAcceptable(puzzle, uci) {
  if (Array.isArray(puzzle.acceptableMoves) && puzzle.acceptableMoves.length > 0) {
    return puzzle.acceptableMoves.includes(uci);
  }
  return uci === puzzle.bestMoveUci;
}

function enterPuzzleMode() {
  if (puzzles.length === 0) return;
  puzzleMode = true;
  variation = null;
  az.variationBar.style.display = "none";
  // A refresh still running from the analysis view would repaint the board over the puzzle.
  hiToken++;
  hi.body.style.display = "none";
  hi.status.textContent = "";
  puzzleIndex = 0;
  puzzleSolved = 0;
  az.puzzlePanel.classList.add("show");
  document.getElementById("analyzeTab").classList.add("practicing");
  if (az.puzzlePanel.scrollIntoView) az.puzzlePanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  loadPuzzle();
}

function loadPuzzle(browsing = false) {
  if (!browsing) puzzleHomeIndex = puzzleIndex;
  az.puzzleBackBtn.style.display = puzzleIndex === puzzleHomeIndex ? "none" : "";
  const puzzle = puzzles[puzzleIndex];
  puzzleFen = puzzle.fenBefore;
  puzzleSelected = null;
  puzzleLegalTargets = [];
  puzzleLocked = false;
  puzzleExp = null;
  puzzleViewIdx = 0;
  az.puzzleFeedback.className = "";
  az.puzzleFeedback.textContent = "";
  az.puzzleRevealBtn.style.display = "";
  az.puzzleNextBtn.style.display = "none";
  az.puzzleActiveActions.style.display = "flex";
  az.puzzleDoneActions.style.display = "none";
  const mover = sideToMove(puzzleFen);
  az.puzzleProgress.textContent = `Puzzle ${puzzleIndex + 1} / ${puzzles.length} — solved ${puzzleSolved}`;
  az.puzzlePrompt.innerHTML = `Find the best move for <b>${mover}</b>.`;
  renderPuzzleBoard(mover === "black");
  drawEvalGraph();
}

function renderPuzzleBoard(flip) {
  const puzzle = puzzles[puzzleIndex];
  let fen = puzzleFen, lastMove = null, arrows = [];
  if (puzzleLocked && puzzle && puzzleExp) {
    const idx = puzzleViewIdx;
    fen = puzzleExp.fens[idx];
    const sq = uciToSquares(idx > 0 ? puzzleExp.ucis[idx - 1] : puzzleExp.ucis[0]);
    if (idx > 0) lastMove = sq;
    if (sq) arrows = [{ from: sq[0], to: sq[1], brush: "blue" }];
    if (idx === 0 && hi.enable.checked && hi.arrows.checked) {
      arrows = hiArrowsFrom(hiData.get(`moves:${analysis.indexOf(puzzle)}:${hiRating()}`)).concat(arrows);
    }
  }
  for (const a of engineArrow(fen)) {
    if (!arrows.some((x) => x.from === a.from && x.to === a.to)) arrows.push(a);
  }
  syncPuzzleNav();
  renderMaterialBars(az.materialTop, az.materialBottom, fen, flip);
  renderChessBoard(az.board, fen, {
    flipped: flip,
    lastMove,
    arrows,
    selected: puzzleSelected,
    legalTargets: puzzleLegalTargets,
    interactive: true,
    canDrag: (piece) => isPieceOfColor(piece, sideToMove(puzzleCurFen())),
    onGrab: onPuzzleSquareClick,
    onDeselect: () => {
      puzzleSelected = null;
      puzzleLegalTargets = [];
      renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    },
    onSquareClick: onPuzzleSquareClick,
    onDropMove: (from, to) => {
      if (puzzleSelected === from && puzzleLegalTargets.length > 0 && !puzzleLegalTargets.includes(to)) {
        renderPuzzleBoard(sideToMove(puzzleFen) === "black");
        return;
      }
      puzzleSelected = null;
      puzzleLegalTargets = [];
      attemptPuzzleMove(from, to);
    },
  });
  engRefresh();
}

async function onPuzzleSquareClick(sq) {
  const curFen = puzzleCurFen();
  const board = fenToBoard(curFen);
  const mover = sideToMove(curFen);
  const piece = board[sq];
  const isOwn = piece && ((mover === "white" && piece === piece.toUpperCase()) ||
                           (mover === "black" && piece === piece.toLowerCase()));

  if (puzzleSelected && puzzleLegalTargets.includes(sq)) {
    const from = puzzleSelected;
    puzzleSelected = null;
    puzzleLegalTargets = [];
    await attemptPuzzleMove(from, sq);
    return;
  }
  if (isOwn) {
    if (puzzleSelected === sq) return;
    puzzleSelected = sq;
    puzzleLegalTargets = [];
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    const fenAtPress = curFen;
    let targets = [];
    try { targets = await invoke("scratch_legal_targets", { fen: curFen, square: sq }); } catch { targets = []; }
    if (puzzleSelected !== sq || puzzleCurFen() !== fenAtPress) return;
    puzzleLegalTargets = targets;
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    return;
  }
  puzzleSelected = null;
  puzzleLegalTargets = [];
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

async function attemptPuzzleMove(from, to) {
  const puzzle = puzzles[puzzleIndex];
  const curFen = puzzleCurFen();
  let promotion = null;
  if (needsPromotionMove(curFen, from, to)) {
    const mover = sideToMove(curFen);
    promotion = await askPromotion(az.promo, mover === "white" ? "w" : "b");
    if (!promotion) { renderPuzzleBoard(sideToMove(puzzleFen) === "black"); return; }
  }
  let result;
  try {
    result = await invoke("scratch_try_move", { fen: curFen, from, to, promotion });
  } catch {
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    return;
  }
  if (puzzleLocked) {
    if (puzzleCurFen() === curFen) playPuzzleFreeMove(result);
    return;
  }
  if (isAcceptable(puzzle, result.uci)) {
    handlePuzzleCorrect(puzzle);
  } else {
    az.puzzleFeedback.className = "show wrong";
    az.puzzleFeedback.textContent = "Not quite — try again.";
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  }
}

function fillPuzzleFeedback(prefix, puzzle) {
  const box = az.puzzleFeedback;
  box.textContent = prefix;
  const line = document.createElement("div");
  line.className = "lineMoves puzzleLine";
  const label = document.createElement("span");
  label.className = "lineLabel";
  label.textContent = "Line:";
  const moves = document.createElement("span");
  moves.className = "lineMoves";
  line.append(label, moves);
  box.appendChild(line);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Move pieces to explore other lines. Turn on the Engine panel to see what else was possible.";
  box.appendChild(hint);
  box.appendChild(buildPuzzleNav());
  refreshPuzzleChips();
  syncPuzzleNav();
}

function buildPuzzleNav() {
  const nav = document.createElement("div");
  nav.className = "navBtns puzzleNav";
  const buttons = [
    ["start", "|\u00ab", "First move (Home)"],
    ["prev", "\u00ab", "Previous move (\u2190)"],
    ["next", "\u00bb", "Next move (\u2192)"],
    ["end", "\u00bb|", "End of line (End)"],
  ];
  for (const [where, label, title] of buttons) {
    const btn = document.createElement("button");
    btn.className = "navBtn";
    btn.dataset.nav = where;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", () => goPuzzleLine(where));
    nav.appendChild(btn);
  }
  return nav;
}

function syncPuzzleNav() {
  const puzzle = puzzles[puzzleIndex];
  const nav = az.puzzleFeedback.querySelector(".puzzleNav");
  if (!nav || !puzzle || !puzzleExp) return;
  const atStart = puzzleViewIdx === 0;
  const atEnd = puzzleViewIdx >= puzzleExp.ucis.length;
  nav.querySelector('[data-nav="start"]').disabled = atStart;
  nav.querySelector('[data-nav="prev"]').disabled = atStart;
  nav.querySelector('[data-nav="next"]').disabled = atEnd;
  nav.querySelector('[data-nav="end"]').disabled = atEnd;
}

// same as azGo(), but for the solution line shown once a puzzle is solved/revealed
function goPuzzleLine(where) {
  const puzzle = puzzles[puzzleIndex];
  if (!puzzleLocked || !puzzleExp) return;
  const last = puzzleExp.ucis.length;
  if (where === "start") puzzleViewIdx = 0;
  else if (where === "end") puzzleViewIdx = last;
  else puzzleViewIdx = Math.max(0, Math.min(last, puzzleViewIdx + (where === "prev" ? -1 : 1)));
  const moves = az.puzzleFeedback.querySelector(".puzzleLine .lineMoves");
  if (moves) setActiveChip(moves, puzzleViewIdx);
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function hiSyncPuzzle() {
  const stale = az.puzzleFeedback.querySelector(".puzzleHuman");
  if (stale) stale.remove();
  if (!puzzleLocked || !puzzles[puzzleIndex]) return;
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzles[puzzleIndex]);
}

// Needs Human insights enabled; only Maia is used here, not Stockfish.
async function puzzleShowHuman(puzzle) {
  const ply = analysis.indexOf(puzzle);
  if (!hi.enable.checked || ply < 0 || !loadedGame) return;
  const rating = hiRating();
  let data;
  try {
    await hiEnsureMaia();
    data = await hiFetchMoves(ply, rating);
  } catch (_) {
    return;
  }
  if (!hi.enable.checked || !puzzleMode || !puzzleLocked || puzzles[puzzleIndex] !== puzzle || !data.moves.length) return;

  renderPuzzleBoard(sideToMove(puzzleFen) === "black");

  const previous = az.puzzleFeedback.querySelector(".puzzleHuman");
  if (previous) previous.remove();
  const line = document.createElement("div");
  line.className = "puzzleHuman";
  const swatch = document.createElement("i");
  swatch.className = "hiSwatch";
  const top = data.moves.slice(0, 3).map((m) => `${m.san} ${hiPct(m.prob)}`).join(" · ");
  const mistake = data.moves.find((m) => m.played);
  line.append(swatch, ` Maia ${rating}: ${top}`);
  if (mistake) line.append(` — the mistake (${mistake.san}) is chosen ${hiPct(mistake.prob)}`);
  az.puzzleFeedback.appendChild(line);
}

function showPuzzleNext() {
  az.puzzleRevealBtn.style.display = "none";
  az.puzzleNextBtn.style.display = "";
  az.puzzleNextBtn.textContent = puzzleIndex + 1 < puzzles.length ? "Next puzzle →" : "Finish";
}

function handlePuzzleCorrect(puzzle) {
  lockPuzzle(puzzle);
  puzzleSolved += 1;
  az.puzzleFeedback.className = "show correct";
  fillPuzzleFeedback("Correct!", puzzle);
  az.puzzleProgress.textContent = `Puzzle ${puzzleIndex + 1} / ${puzzles.length} — solved ${puzzleSolved}`;
  showPuzzleNext();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzle);
}

// no auto-advance, so the solution line can be clicked through
az.puzzleNextBtn.addEventListener("click", () => {
  if (!puzzleLocked) return;
  if (puzzleIndex + 1 < puzzles.length) {
    puzzleIndex += 1;
    loadPuzzle();
  } else {
    finishPuzzles();
  }
});

az.puzzleRevealBtn.addEventListener("click", () => {
  if (puzzleLocked) return;
  const puzzle = puzzles[puzzleIndex];
  lockPuzzle(puzzle);
  az.puzzleFeedback.className = "show reveal";
  fillPuzzleFeedback(`Answer: ${puzzle.bestMoveSan || "(no line available)"}`, puzzle);
  showPuzzleNext();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzle);
});

az.puzzleBackBtn.addEventListener("click", () => {
  puzzleIndex = puzzleHomeIndex;
  loadPuzzle();
});

az.puzzleExitBtn.addEventListener("click", exitPuzzleMode);
az.puzzleExitBtn2.addEventListener("click", exitPuzzleMode);
az.puzzleRestartBtn.addEventListener("click", enterPuzzleMode);

function finishPuzzles() {
  az.puzzleActiveActions.style.display = "none";
  az.puzzleDoneActions.style.display = "flex";
  az.puzzleProgress.textContent = `Done! Solved ${puzzleSolved} / ${puzzles.length}.`;
  az.puzzlePrompt.textContent = "";
}

function exitPuzzleMode() {
  puzzleMode = false;
  az.puzzlePanel.classList.remove("show");
  document.getElementById("analyzeTab").classList.remove("practicing");
  renderAnalyzeBoard();
}

renderAnalyzeBoard();
