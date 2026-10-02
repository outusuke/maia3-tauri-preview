// Port of WintrChess's brilliant check; it needs chess.js quirks (king captures, flipped turns) the `chess` crate rejects.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    W,
    B,
}

impl Side {
    fn flip(self) -> Side {
        match self {
            Side::W => Side::B,
            Side::B => Side::W,
        }
    }
    fn idx(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    P,
    N,
    B,
    R,
    Q,
    K,
}

fn value(kind: Kind) -> i32 {
    match kind {
        Kind::P => 1,
        Kind::N | Kind::B => 3,
        Kind::R => 5,
        Kind::Q => 9,
        Kind::K => 1000,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Pc {
    side: Side,
    kind: Kind,
}

const KS: u8 = 1;
const QS: u8 = 2;
const FLAG_EP: u8 = 1;
const FLAG_BIG: u8 = 2;
const FLAG_KS: u8 = 4;
const FLAG_QS: u8 = 8;

// Order matters: ties between equal-sized sets resolve by move order.
const PROMOTIONS: [Kind; 4] = [Kind::Q, Kind::R, Kind::B, Kind::N];

const KNIGHT_STEPS: [(i32, i32); 8] = [(1, -2), (2, -1), (2, 1), (1, 2), (-1, 2), (-2, 1), (-2, -1), (-1, -2)];
const BISHOP_STEPS: [(i32, i32); 4] = [(1, -1), (1, 1), (-1, 1), (-1, -1)];
const ROOK_STEPS: [(i32, i32); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];
const KING_STEPS: [(i32, i32); 8] = [(1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1)];

fn step(sq: usize, dr: i32, df: i32) -> Option<usize> {
    let r = (sq / 8) as i32 + dr;
    let f = (sq % 8) as i32 + df;
    if (0..8).contains(&r) && (0..8).contains(&f) {
        Some((r * 8 + f) as usize)
    } else {
        None
    }
}

// a8..h1, like chess.js.
fn board_order() -> impl Iterator<Item = usize> {
    (0..8usize).rev().flat_map(|r| (0..8usize).map(move |f| r * 8 + f))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Mv {
    from: usize,
    to: usize,
    piece: Kind,
    side: Side,
    captured: Option<Kind>,
    promo: Option<Kind>,
    flags: u8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Raw {
    piece: Kind,
    side: Side,
    from: usize,
    to: usize,
    promo: Option<Kind>,
}

impl From<&Mv> for Raw {
    fn from(m: &Mv) -> Raw {
        Raw { piece: m.piece, side: m.side, from: m.from, to: m.to, promo: m.promo }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Bp {
    sq: usize,
    kind: Kind,
    side: Side,
}

fn raw_as_piece(r: &Raw) -> Bp {
    Bp { sq: r.from, kind: r.piece, side: r.side }
}

#[derive(Clone)]
struct Pos {
    b: [Option<Pc>; 64],
    turn: Side,
    ep: Option<usize>,
    castle: [u8; 2],
}

impl Pos {
    fn from_fen(fen: &str) -> Option<Pos> {
        let mut parts = fen.split_whitespace();
        let rows = parts.next()?;
        let turn = match parts.next()? {
            "w" => Side::W,
            "b" => Side::B,
            _ => return None,
        };
        let castling = parts.next().unwrap_or("-");
        let ep = parts.next().unwrap_or("-");

        let mut b = [None; 64];
        for (i, row) in rows.split('/').enumerate() {
            let rank = 7usize.checked_sub(i)?;
            let mut file = 0usize;
            for ch in row.chars() {
                if let Some(n) = ch.to_digit(10) {
                    file += n as usize;
                    continue;
                }
                let side = if ch.is_ascii_uppercase() { Side::W } else { Side::B };
                let kind = match ch.to_ascii_lowercase() {
                    'p' => Kind::P,
                    'n' => Kind::N,
                    'b' => Kind::B,
                    'r' => Kind::R,
                    'q' => Kind::Q,
                    'k' => Kind::K,
                    _ => return None,
                };
                if file > 7 {
                    return None;
                }
                b[rank * 8 + file] = Some(Pc { side, kind });
                file += 1;
            }
        }

        let mut castle = [0u8; 2];
        for ch in castling.chars() {
            match ch {
                'K' => castle[0] |= KS,
                'Q' => castle[0] |= QS,
                'k' => castle[1] |= KS,
                'q' => castle[1] |= QS,
                _ => {}
            }
        }

        let ep = if ep.len() == 2 {
            let bytes = ep.as_bytes();
            Some((bytes[1] - b'1') as usize * 8 + (bytes[0] - b'a') as usize)
        } else {
            None
        };

        let mut pos = Pos { b, turn, ep, castle };
        pos.refresh_castling();
        pos.refresh_ep();
        Some(pos)
    }

    fn king_sq(&self, side: Side) -> Option<usize> {
        board_order().find(|&s| self.b[s] == Some(Pc { side, kind: Kind::K }))
    }

    fn refresh_castling(&mut self) {
        let at = |s: &Pos, sq: usize, side: Side, kind: Kind| s.b[sq] == Some(Pc { side, kind });
        let wk = at(self, 4, Side::W, Kind::K);
        let bk = at(self, 60, Side::B, Kind::K);
        if !wk || !at(self, 0, Side::W, Kind::R) {
            self.castle[0] &= !QS;
        }
        if !wk || !at(self, 7, Side::W, Kind::R) {
            self.castle[0] &= !KS;
        }
        if !bk || !at(self, 56, Side::B, Kind::R) {
            self.castle[1] &= !QS;
        }
        if !bk || !at(self, 63, Side::B, Kind::R) {
            self.castle[1] &= !KS;
        }
    }

    fn refresh_ep(&mut self) {
        let Some(ep) = self.ep else { return };
        let (start_dr, cur_dr) = if self.turn == Side::W { (1, -1) } else { (-1, 1) };
        let start = step(ep, start_dr, 0);
        let current = step(ep, cur_dr, 0);
        let valid = match (start, current) {
            (Some(start), Some(current)) => {
                self.b[start].is_none()
                    && self.b[ep].is_none()
                    && self.b[current] == Some(Pc { side: self.turn.flip(), kind: Kind::P })
                    && [1, -1].iter().any(|&df| {
                        step(current, 0, df).map_or(false, |s| self.b[s] == Some(Pc { side: self.turn, kind: Kind::P }))
                    })
            }
            _ => false,
        };
        if !valid {
            self.ep = None;
        }
    }

    fn attacks(&self, from: usize, pc: Pc, target: usize) -> bool {
        if from == target {
            return false;
        }
        let dr = (target / 8) as i32 - (from / 8) as i32;
        let df = (target % 8) as i32 - (from % 8) as i32;
        let clear = |dr: i32, df: i32| {
            let (sr, sf) = (dr.signum(), df.signum());
            let mut cur = step(from, sr, sf);
            while let Some(s) = cur {
                if s == target {
                    return true;
                }
                if self.b[s].is_some() {
                    return false;
                }
                cur = step(s, sr, sf);
            }
            false
        };
        match pc.kind {
            Kind::P => dr == if pc.side == Side::W { 1 } else { -1 } && df.abs() == 1,
            Kind::N => (dr.abs() == 1 && df.abs() == 2) || (dr.abs() == 2 && df.abs() == 1),
            Kind::K => dr.abs().max(df.abs()) == 1,
            Kind::B => dr.abs() == df.abs() && clear(dr, df),
            Kind::R => (dr == 0 || df == 0) && clear(dr, df),
            Kind::Q => (dr.abs() == df.abs() || dr == 0 || df == 0) && clear(dr, df),
        }
    }

    fn attackers(&self, side: Side, target: usize) -> Vec<usize> {
        board_order()
            .filter(|&s| matches!(self.b[s], Some(pc) if pc.side == side && self.attacks(s, pc, target)))
            .collect()
    }

    fn is_attacked(&self, side: Side, target: usize) -> bool {
        board_order().any(|s| matches!(self.b[s], Some(pc) if pc.side == side && self.attacks(s, pc, target)))
    }

    fn king_attacked(&self, side: Side) -> bool {
        self.king_sq(side).map_or(false, |k| self.is_attacked(side.flip(), k))
    }

    fn is_check(&self) -> bool {
        self.king_attacked(self.turn)
    }

    fn add_move(&self, out: &mut Vec<Mv>, from: usize, to: usize, piece: Kind, captured: Option<Kind>, flags: u8) {
        let side = self.b[from].map(|p| p.side).unwrap_or(self.turn);
        let base = Mv { from, to, piece, side, captured, promo: None, flags };
        if piece == Kind::P && (to / 8 == 0 || to / 8 == 7) {
            for promo in PROMOTIONS {
                out.push(Mv { promo: Some(promo), ..base });
            }
        } else {
            out.push(base);
        }
    }

    fn pseudo_moves(&self, only: Option<usize>) -> Vec<Mv> {
        let us = self.turn;
        let them = us.flip();
        let mut out = Vec::new();
        let squares: Vec<usize> = match only {
            Some(s) => vec![s],
            None => board_order().collect(),
        };

        for from in squares {
            let Some(pc) = self.b[from] else { continue };
            if pc.side == them {
                continue;
            }
            match pc.kind {
                Kind::P => {
                    let dir = if us == Side::W { 1 } else { -1 };
                    if let Some(to) = step(from, dir, 0) {
                        if self.b[to].is_none() {
                            self.add_move(&mut out, from, to, Kind::P, None, 0);
                            let second_rank = if us == Side::W { 1 } else { 6 };
                            if from / 8 == second_rank {
                                if let Some(to2) = step(from, 2 * dir, 0) {
                                    if self.b[to2].is_none() {
                                        self.add_move(&mut out, from, to2, Kind::P, None, FLAG_BIG);
                                    }
                                }
                            }
                        }
                    }
                    let capture_files: [i32; 2] = if us == Side::W { [-1, 1] } else { [1, -1] };
                    for df in capture_files {
                        let Some(to) = step(from, dir, df) else { continue };
                        match self.b[to] {
                            Some(t) if t.side == them => {
                                self.add_move(&mut out, from, to, Kind::P, Some(t.kind), 0);
                            }
                            _ if self.ep == Some(to) => {
                                self.add_move(&mut out, from, to, Kind::P, Some(Kind::P), FLAG_EP);
                            }
                            _ => {}
                        }
                    }
                }
                kind => {
                    let steps: &[(i32, i32)] = match kind {
                        Kind::N => &KNIGHT_STEPS,
                        Kind::B => &BISHOP_STEPS,
                        Kind::R => &ROOK_STEPS,
                        _ => &KING_STEPS,
                    };
                    let single = matches!(kind, Kind::N | Kind::K);
                    for &(dr, df) in steps {
                        let mut cur = from;
                        while let Some(to) = step(cur, dr, df) {
                            match self.b[to] {
                                None => self.add_move(&mut out, from, to, kind, None, 0),
                                Some(t) => {
                                    if t.side != us {
                                        self.add_move(&mut out, from, to, kind, Some(t.kind), 0);
                                    }
                                    break;
                                }
                            }
                            if single {
                                break;
                            }
                            cur = to;
                        }
                    }
                }
            }
        }

        if let Some(kq) = self.king_sq(us) {
            if only.is_none() || only == Some(kq) {
                let file = kq % 8;
                if self.castle[us.idx()] & KS != 0 && file + 2 < 8 {
                    if self.b[kq + 1].is_none()
                        && self.b[kq + 2].is_none()
                        && !self.is_attacked(them, kq)
                        && !self.is_attacked(them, kq + 1)
                        && !self.is_attacked(them, kq + 2)
                    {
                        self.add_move(&mut out, kq, kq + 2, Kind::K, None, FLAG_KS);
                    }
                }
                if self.castle[us.idx()] & QS != 0 && file >= 3 {
                    if self.b[kq - 1].is_none()
                        && self.b[kq - 2].is_none()
                        && self.b[kq - 3].is_none()
                        && !self.is_attacked(them, kq)
                        && !self.is_attacked(them, kq - 1)
                        && !self.is_attacked(them, kq - 2)
                    {
                        self.add_move(&mut out, kq, kq - 2, Kind::K, None, FLAG_QS);
                    }
                }
            }
        }
        out
    }

    fn legal_moves(&self, only: Option<usize>) -> Vec<Mv> {
        let us = self.turn;
        let pseudo = self.pseudo_moves(only);
        if self.king_sq(us).is_none() {
            return pseudo;
        }
        pseudo
            .into_iter()
            .filter(|m| {
                let mut next = self.clone();
                next.apply(m);
                !next.king_attacked(us)
            })
            .collect()
    }

    fn apply(&mut self, m: &Mv) {
        let us = self.turn;
        let them = us.flip();
        let moved = self.b[m.from].take();
        self.b[m.to] = moved;

        if m.flags & FLAG_EP != 0 {
            let victim = if us == Side::B { step(m.to, 1, 0) } else { step(m.to, -1, 0) };
            if let Some(v) = victim {
                self.b[v] = None;
            }
        }
        if let Some(promo) = m.promo {
            self.b[m.to] = Some(Pc { side: us, kind: promo });
        }

        if self.b[m.to].map(|p| p.kind) == Some(Kind::K) {
            if m.flags & FLAG_KS != 0 {
                self.b[m.to - 1] = self.b[m.to + 1].take();
            } else if m.flags & FLAG_QS != 0 {
                self.b[m.to + 1] = self.b[m.to - 2].take();
            }
            self.castle[us.idx()] = 0;
        }

        let rooks = |side: Side| -> [(usize, u8); 2] {
            if side == Side::W {
                [(0, QS), (7, KS)]
            } else {
                [(56, QS), (63, KS)]
            }
        };
        for (sq, flag) in rooks(us) {
            if m.from == sq && self.castle[us.idx()] & flag != 0 {
                self.castle[us.idx()] ^= flag;
                break;
            }
        }
        for (sq, flag) in rooks(them) {
            if m.to == sq && self.castle[them.idx()] & flag != 0 {
                self.castle[them.idx()] ^= flag;
                break;
            }
        }

        self.ep = None;
        if m.flags & FLAG_BIG != 0 {
            let ep = if us == Side::B { step(m.to, 1, 0) } else { step(m.to, -1, 0) };
            let enemy_pawn = |df: i32| {
                step(m.to, 0, df).map_or(false, |s| self.b[s] == Some(Pc { side: them, kind: Kind::P }))
            };
            if enemy_pawn(-1) || enemy_pawn(1) {
                self.ep = ep;
            }
        }
        self.turn = them;
    }

    // Fails on illegal moves, like chess.js's move().
    fn play(&mut self, from: usize, to: usize, promo: Option<Kind>) -> Option<Mv> {
        let found = self
            .legal_moves(None)
            .into_iter()
            .find(|m| m.from == from && m.to == to && (m.promo.is_none() || m.promo == promo))?;
        self.apply(&found);
        Some(found)
    }

    fn is_checkmate(&self) -> bool {
        self.is_check() && self.legal_moves(None).is_empty()
    }

    // The original always drops en passant when it flips the turn.
    fn with_turn(&self, side: Side) -> Pos {
        let mut p = self.clone();
        p.turn = side;
        p.ep = None;
        p
    }

    fn removed(&self, sq: usize) -> Pos {
        let mut p = self.clone();
        p.b[sq] = None;
        p.refresh_castling();
        p.refresh_ep();
        p
    }

    fn put(&self, pc: Pc, sq: usize) -> Pos {
        let mut p = self.clone();
        p.b[sq] = Some(pc);
        p.refresh_castling();
        p.refresh_ep();
        p
    }

    fn has_mate_in_one(&self) -> bool {
        self.legal_moves(None).iter().any(|m| {
            let mut next = self.clone();
            next.apply(m);
            next.is_checkmate()
        })
    }
}

fn capture_square(m: &Mv) -> usize {
    if m.flags & FLAG_EP != 0 {
        (m.from / 8) * 8 + m.to % 8
    } else {
        m.to
    }
}

fn direct_attacking_moves(pos: &Pos, piece: Bp) -> Vec<Raw> {
    let attacker = piece.side.flip();
    let board = pos.with_turn(attacker);
    let mut moves: Vec<Raw> = board
        .legal_moves(None)
        .iter()
        .filter(|m| capture_square(m) == piece.sq)
        .map(Raw::from)
        .collect();

    let king_attacker = board
        .attackers(attacker, piece.sq)
        .into_iter()
        .find(|&s| board.b[s].map(|p| p.kind) == Some(Kind::K));
    if let Some(from) = king_attacker {
        if !moves.iter().any(|m| m.piece == Kind::K) {
            moves.push(Raw { piece: Kind::K, side: attacker, from, to: piece.sq, promo: None });
        }
    }
    moves
}

fn xor_raw(a: &[Raw], b: &[Raw]) -> Vec<Raw> {
    let mut out: Vec<Raw> = a.iter().filter(|x| !b.contains(x)).copied().collect();
    out.extend(b.iter().filter(|x| !a.contains(x)).copied());
    out
}

fn get_attacking_moves(pos: &Pos, piece: Bp, transitive: bool) -> Vec<Raw> {
    let mut attacking = direct_attacking_moves(pos, piece);
    if !transitive {
        return attacking;
    }

    struct Front {
        pos: Pos,
        sq: usize,
        kind: Kind,
    }
    let mut frontier: Vec<Front> = attacking
        .iter()
        .map(|m| Front { pos: pos.clone(), sq: m.from, kind: m.piece })
        .collect();

    while let Some(front) = frontier.pop() {
        if front.kind == Kind::K {
            continue;
        }
        let old = direct_attacking_moves(&front.pos, piece);
        let stripped = front.pos.removed(front.sq);
        let old_without: Vec<Raw> = old.into_iter().filter(|m| m.from != front.sq).collect();
        let revealed = xor_raw(&old_without, &direct_attacking_moves(&stripped, piece));

        attacking.extend(revealed.iter().copied());
        for m in &revealed {
            frontier.push(Front { pos: stripped.clone(), sq: m.from, kind: m.piece });
        }
    }
    attacking
}

fn get_defending_moves(pos: &Pos, piece: Bp, transitive: bool) -> Vec<Raw> {
    let attacking = get_attacking_moves(pos, piece, false);
    let recapture_sets: Vec<Vec<Raw>> = attacking
        .iter()
        .filter_map(|am| {
            let mut capture_board = pos.with_turn(piece.side.flip());
            capture_board.play(am.from, am.to, am.promo)?;
            Some(get_attacking_moves(
                &capture_board,
                Bp { sq: am.to, kind: am.piece, side: am.side },
                transitive,
            ))
        })
        .collect();

    let smallest = recapture_sets.into_iter().reduce(|best, next| if next.len() < best.len() { next } else { best });
    if let Some(set) = smallest {
        return set;
    }

    let flipped = Bp { sq: piece.sq, kind: piece.kind, side: piece.side.flip() };
    let swapped = pos.put(Pc { side: flipped.side, kind: flipped.kind }, piece.sq);
    get_attacking_moves(&swapped, flipped, transitive)
}

fn is_piece_safe(pos: &Pos, piece: Bp, played: Option<&Mv>) -> bool {
    let direct: Vec<Bp> = get_attacking_moves(pos, piece, false).iter().map(raw_as_piece).collect();
    let attackers: Vec<Bp> = get_attacking_moves(pos, piece, true).iter().map(raw_as_piece).collect();
    let defenders: Vec<Bp> = get_defending_moves(pos, piece, true).iter().map(raw_as_piece).collect();

    if let Some(captured) = played.and_then(|m| m.captured) {
        if piece.kind == Kind::R
            && value(captured) == value(Kind::N)
            && attackers.len() == 1
            && !defenders.is_empty()
            && value(attackers[0].kind) == value(Kind::N)
        {
            return true;
        }
    }

    if direct.iter().any(|a| value(a.kind) < value(piece.kind)) {
        return false;
    }
    if attackers.len() <= defenders.len() {
        return true;
    }

    let lowest = direct.iter().copied().reduce(|best, next| if value(next.kind) < value(best.kind) { next } else { best });
    let Some(lowest) = lowest else { return true };

    if value(piece.kind) < value(lowest.kind) && defenders.iter().any(|d| value(d.kind) < value(lowest.kind)) {
        return true;
    }
    defenders.iter().any(|d| d.kind == Kind::P)
}

fn get_unsafe_pieces(pos: &Pos, side: Side, played: Option<&Mv>) -> Vec<Bp> {
    let captured_value = played.and_then(|m| m.captured).map_or(0, value);
    board_order()
        .filter_map(|sq| {
            let pc = pos.b[sq]?;
            Some(Bp { sq, kind: pc.kind, side: pc.side })
        })
        .filter(|p| {
            p.side == side
                && p.kind != Kind::P
                && p.kind != Kind::K
                && value(p.kind) > captured_value
                && !is_piece_safe(pos, *p, played)
        })
        .collect()
}

fn relative_unsafe_piece_attacks(pos: &Pos, threatened: Bp, side: Side, played: Option<&Mv>) -> Vec<Raw> {
    get_unsafe_pieces(pos, side, played)
        .into_iter()
        .filter(|u| u.sq != threatened.sq && value(u.kind) >= value(threatened.kind))
        .flat_map(|u| get_attacking_moves(pos, u, false))
        .collect()
}

#[derive(Clone, Copy)]
struct Acting {
    from: usize,
    to: usize,
    promo: Option<Kind>,
    side: Side,
}

fn low_value_checkmate_pin(action_board: &Pos, threatened: Bp) -> bool {
    value(threatened.kind) < value(Kind::Q) && action_board.has_mate_in_one()
}

fn move_creates_greater_threat(pos: &Pos, threatened: Bp, acting: Acting) -> bool {
    let mut action_board = pos.clone();
    let previous = relative_unsafe_piece_attacks(&action_board, threatened, acting.side, None);

    let Some(baked) = action_board.play(acting.from, acting.to, acting.promo) else {
        return false;
    };
    let relative = relative_unsafe_piece_attacks(&action_board, threatened, acting.side, Some(&baked));

    if relative.iter().any(|r| !previous.contains(r)) {
        return true;
    }
    low_value_checkmate_pin(&action_board, threatened)
}

fn move_leaves_greater_threat(pos: &Pos, threatened: Bp, acting: Acting) -> bool {
    let mut action_board = pos.clone();
    if action_board.play(acting.from, acting.to, acting.promo).is_none() {
        return false;
    }
    if !relative_unsafe_piece_attacks(&action_board, threatened, acting.side, None).is_empty() {
        return true;
    }
    low_value_checkmate_pin(&action_board, threatened)
}

fn has_danger_levels(pos: &Pos, threatened: Bp, acting_moves: &[Raw]) -> bool {
    acting_moves.iter().all(|m| {
        move_leaves_greater_threat(pos, threatened, Acting { from: m.from, to: m.to, promo: m.promo, side: m.side })
    })
}

fn is_piece_trapped(pos: &Pos, piece: Bp) -> bool {
    let calibrated = pos.with_turn(piece.side);
    let standing_safe = is_piece_safe(&calibrated, piece, None);

    let all_moves_unsafe = calibrated.legal_moves(Some(piece.sq)).iter().all(|m| {
        if m.captured == Some(Kind::K) {
            return false;
        }
        let acting = Acting { from: m.from, to: m.to, promo: m.promo, side: m.side };
        if move_creates_greater_threat(&calibrated, piece, acting) {
            return true;
        }
        let mut escape = calibrated.clone();
        let Some(escaped) = escape.play(m.from, m.to, m.promo) else {
            return false;
        };
        !is_piece_safe(&escape, Bp { sq: escaped.to, ..piece }, Some(&escaped))
    });

    !standing_safe && all_moves_unsafe
}

/// Mover's perspective; for mates, negative means being mated.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Eval {
    pub mate: bool,
    pub value: i32,
}

pub(crate) struct BrilliantInput<'a> {
    pub fen_before: &'a str,
    pub uci: &'a str,
    pub top_move_played: bool,
    pub prev_top: Eval,
    pub prev_second: Option<Eval>,
    pub current: Eval,
}

fn expected_points(cp: i32) -> f64 {
    1.0 / (1.0 + (-0.0035 * cp as f64).exp())
}

// Only the BEST bucket of the original point-loss grading matters here.
fn point_loss_is_best(prev: Eval, cur: Eval) -> bool {
    match (prev.mate, cur.mate) {
        (true, true) => {
            if prev.value > 0 && cur.value < 0 {
                return false;
            }
            let mate_loss = cur.value - prev.value;
            mate_loss < 0 || (mate_loss == 0 && cur.value < 0)
        }
        (true, false) => false,
        (false, true) => cur.value > 0,
        (false, false) => (expected_points(prev.value) - expected_points(cur.value)).max(0.0) < 0.01,
    }
}

fn parse_uci(uci: &str) -> Option<(usize, usize, Option<Kind>)> {
    let b = uci.as_bytes();
    if b.len() < 4 {
        return None;
    }
    let sq = |f: u8, r: u8| Some((r.checked_sub(b'1')? as usize) * 8 + f.checked_sub(b'a')? as usize);
    let from = sq(b[0], b[1])?;
    let to = sq(b[2], b[3])?;
    let promo = match b.get(4) {
        Some(b'q') => Some(Kind::Q),
        Some(b'r') => Some(Kind::R),
        Some(b'b') => Some(Kind::B),
        Some(b'n') => Some(Kind::N),
        _ => None,
    };
    Some((from, to, promo))
}

pub(crate) fn is_brilliant(input: &BrilliantInput) -> bool {
    let Some(before) = Pos::from_fen(input.fen_before) else {
        return false;
    };
    let Some((from, to, promo)) = parse_uci(input.uci) else {
        return false;
    };

    if before.legal_moves(None).len() <= 1 {
        return false;
    }
    let mut after = before.clone();
    let Some(played) = after.play(from, to, promo) else {
        return false;
    };
    if after.is_checkmate() {
        return false;
    }
    if !(input.top_move_played || point_loss_is_best(input.prev_top, input.current)) {
        return false;
    }

    // isMoveCriticalCandidate
    match input.prev_second {
        Some(second) => {
            if !second.mate && second.value >= 700 {
                return false;
            }
        }
        None => {
            if !input.current.mate && input.current.value >= 700 {
                return false;
            }
        }
    }
    if input.current.value < 0 || promo == Some(Kind::Q) || before.is_check() {
        return false;
    }

    // considerBrilliantClassification
    if played.promo.is_some() {
        return false;
    }
    let mover = played.side;

    let previous_unsafe = get_unsafe_pieces(&before, mover, None);
    let unsafe_now = get_unsafe_pieces(&after, mover, Some(&played));

    if !after.is_check() && unsafe_now.len() < previous_unsafe.len() {
        return false;
    }

    let protected = unsafe_now
        .iter()
        .all(|p| has_danger_levels(&after, *p, &get_attacking_moves(&after, *p, false)));
    if protected {
        return false;
    }

    let previous_trapped: Vec<Bp> = previous_unsafe.iter().copied().filter(|p| is_piece_trapped(&before, *p)).collect();
    let trapped_now = unsafe_now.iter().filter(|p| is_piece_trapped(&after, **p)).count();
    let moved_piece_trapped = previous_trapped.iter().any(|p| p.sq == played.from);

    if trapped_now == unsafe_now.len() || moved_piece_trapped || trapped_now < previous_trapped.len() {
        return false;
    }

    !unsafe_now.is_empty()
}
