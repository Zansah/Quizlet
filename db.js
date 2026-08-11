/* ============================================
   QUIZLY — DATABASE LAYER (db.js)
   All persistence via localStorage.
   Schema versioning + migration support.
   ============================================ */

const DB = (() => {

  const SCHEMA_VERSION = 2;
  const KEYS = {
    VERSION:  'quizly_schema_version',
    SETS:     'quizly_sets',
    PROGRESS: 'quizly_progress',
    SESSIONS: 'quizly_sessions',
    META:     'quizly_meta',
  };

  /* ---- Internal helpers ---- */

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('[DB] read error', key, e);
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('[DB] write error', key, e);
      return false;
    }
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function now() {
    return new Date().toISOString();
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ---- Schema init & migration ---- */

  function init() {
    const version = read(KEYS.VERSION);
    if (!version) {
      // Fresh install
      write(KEYS.VERSION, SCHEMA_VERSION);
      write(KEYS.SETS, {});
      write(KEYS.PROGRESS, {});
      write(KEYS.SESSIONS, []);
      write(KEYS.META, {
        createdAt: now(),
        streak: 0,
        bestStreak: 0,
        lastStudyDate: null,
        totalCardsStudied: 0,
      });
      _seedDemoData();
      return;
    }
    if (version < SCHEMA_VERSION) {
      _migrate(version);
    }
  }

  function _migrate(fromVersion) {
    // v1 -> v2: add description field to sets
    if (fromVersion < 2) {
      const sets = read(KEYS.SETS) || {};
      Object.values(sets).forEach(s => {
        if (s.description === undefined) s.description = '';
      });
      write(KEYS.SETS, sets);
    }
    write(KEYS.VERSION, SCHEMA_VERSION);
  }

  function _seedDemoData() {
    const demoSets = [
      {
        title: 'Biology — Cell Structure',
        subject: 'Biology',
        description: 'Core organelles and their functions.',
        cards: [
          { term: 'Mitochondria',         definition: 'Organelle that generates ATP through cellular respiration. Known as the powerhouse of the cell.' },
          { term: 'Nucleus',              definition: 'Control center of the cell; contains DNA and directs cellular activities.' },
          { term: 'Ribosome',             definition: 'Site of protein synthesis; reads mRNA and assembles amino acid chains.' },
          { term: 'Cell Membrane',        definition: 'Semi-permeable lipid bilayer that surrounds the cell and regulates what enters and exits.' },
          { term: 'Chloroplast',          definition: 'Organelle in plant cells where photosynthesis occurs; contains chlorophyll.' },
          { term: 'Endoplasmic Reticulum',definition: 'Network of membranes involved in protein (rough ER) and lipid (smooth ER) synthesis.' },
          { term: 'Golgi Apparatus',      definition: 'Packages and exports proteins and lipids produced by the ER; the cell\'s post office.' },
          { term: 'Lysosome',             definition: 'Contains digestive enzymes to break down waste materials and cellular debris.' },
        ]
      },
      {
        title: 'U.S. History — WWII',
        subject: 'History',
        description: 'Key events and terms from the World War II era.',
        cards: [
          { term: 'Pearl Harbor',      definition: 'December 7, 1941 surprise attack by Japan on the U.S. naval base; brought the U.S. into WWII.' },
          { term: 'D-Day',             definition: 'June 6, 1944 Allied invasion of Normandy, France; the largest seaborne invasion in history.' },
          { term: 'Manhattan Project', definition: 'Secret U.S.-led program to develop the first nuclear weapons during WWII.' },
          { term: 'Lend-Lease Act',    definition: '1941 law allowing the U.S. to supply Allied nations with war materials before entering the war.' },
          { term: 'VE Day',            definition: 'May 8, 1945 — Victory in Europe Day, marking the end of WWII in the European theater.' },
          { term: 'VJ Day',            definition: 'September 2, 1945 — Victory over Japan, marking the formal end of WWII.' },
        ]
      },
    ];
    demoSets.forEach(s => Sets.create(s.title, s.subject, s.description, s.cards));
  }

  /* ---- SETS CRUD ---- */

  const Sets = {
    all() {
      return read(KEYS.SETS) || {};
    },

    list() {
      const sets = this.all();
      return Object.values(sets).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    get(id) {
      return (read(KEYS.SETS) || {})[id] || null;
    },

    create(title, subject, description, cards) {
      const sets = this.all();
      const id = uuid();
      const ts = now();
      const setObj = {
        id,
        title:       title.trim(),
        subject:     subject || 'General',
        description: (description || '').trim(),
        cards:       cards.map((c, i) => ({
          id:         uuid(),
          order:      i,
          term:       c.term.trim(),
          definition: c.definition.trim(),
          createdAt:  ts,
        })),
        createdAt: ts,
        updatedAt: ts,
      };
      sets[id] = setObj;
      write(KEYS.SETS, sets);
      return setObj;
    },

    update(id, title, subject, description, cards) {
      const sets = this.all();
      if (!sets[id]) return null;
      const ts = now();
      sets[id].title       = title.trim();
      sets[id].subject     = subject || 'General';
      sets[id].description = (description || '').trim();
      sets[id].updatedAt   = ts;
      // Merge existing card IDs where possible, assign new ones otherwise
      const oldCards = sets[id].cards;
      sets[id].cards = cards.map((c, i) => {
        const existing = oldCards.find(old => old.id === c.id);
        return {
          id:         existing ? existing.id : uuid(),
          order:      i,
          term:       c.term.trim(),
          definition: c.definition.trim(),
          createdAt:  existing ? existing.createdAt : ts,
        };
      });
      write(KEYS.SETS, sets);
      return sets[id];
    },

    delete(id) {
      const sets = this.all();
      if (!sets[id]) return false;
      delete sets[id];
      write(KEYS.SETS, sets);
      // Clean up progress for this set
      const progress = read(KEYS.PROGRESS) || {};
      delete progress[id];
      write(KEYS.PROGRESS, progress);
      return true;
    },

    count() {
      return Object.keys(this.all()).length;
    },

    totalCards() {
      return Object.values(this.all()).reduce((acc, s) => acc + s.cards.length, 0);
    },
  };

  /* ---- PROGRESS ---- */
  // Progress schema per set:
  // { setId: { cardId: { correct, incorrect, lastSeen, mastered }, sessionAccuracy: [] } }

  const Progress = {
    forSet(setId) {
      const all = read(KEYS.PROGRESS) || {};
      return all[setId] || { cards: {}, sessionAccuracy: [] };
    },

    _save(setId, data) {
      const all = read(KEYS.PROGRESS) || {};
      all[setId] = data;
      write(KEYS.PROGRESS, all);
    },

    recordCard(setId, cardId, correct) {
      const p = this.forSet(setId);
      if (!p.cards) p.cards = {};
      if (!p.cards[cardId]) p.cards[cardId] = { correct: 0, incorrect: 0, lastSeen: null, mastered: false };
      const c = p.cards[cardId];
      if (correct) c.correct++; else c.incorrect++;
      c.lastSeen = now();
      // Mastered = 3+ correct with accuracy >= 80%
      const total = c.correct + c.incorrect;
      c.mastered = (c.correct >= 3) && (c.correct / total >= 0.8);
      this._save(setId, p);
      // Update global meta
      Meta.incrementCardsStudied();
    },

    recordSession(setId, correct, total) {
      const p = this.forSet(setId);
      if (!p.sessionAccuracy) p.sessionAccuracy = [];
      p.sessionAccuracy.push({
        date: todayStr(),
        correct,
        total,
        pct: total > 0 ? Math.round((correct / total) * 100) : 0,
      });
      // Keep last 20 sessions per set
      if (p.sessionAccuracy.length > 20) p.sessionAccuracy = p.sessionAccuracy.slice(-20);
      this._save(setId, p);
    },

    masteryForSet(setId) {
      const set = Sets.get(setId);
      if (!set || set.cards.length === 0) return 0;
      const p = this.forSet(setId);
      if (!p.cards) return 0;
      const mastered = set.cards.filter(c => p.cards[c.id]?.mastered).length;
      return Math.round((mastered / set.cards.length) * 100);
    },

    accuracyForSet(setId) {
      const p = this.forSet(setId);
      if (!p.sessionAccuracy || p.sessionAccuracy.length === 0) return null;
      const last = p.sessionAccuracy.slice(-5);
      const avg = last.reduce((a, s) => a + s.pct, 0) / last.length;
      return Math.round(avg);
    },

    globalAccuracy() {
      const all = read(KEYS.PROGRESS) || {};
      let total = 0, count = 0;
      Object.values(all).forEach(p => {
        if (p.sessionAccuracy && p.sessionAccuracy.length) {
          p.sessionAccuracy.slice(-5).forEach(s => { total += s.pct; count++; });
        }
      });
      return count > 0 ? Math.round(total / count) : null;
    },
  };

  /* ---- SESSIONS ---- */

  const Sessions = {
    all() {
      return read(KEYS.SESSIONS) || [];
    },

    log(setId, mode, correct, total, durationMs) {
      const sessions = this.all();
      sessions.push({
        id:         uuid(),
        setId,
        mode,
        correct,
        total,
        durationMs,
        date:       todayStr(),
        timestamp:  now(),
      });
      // Keep last 200 sessions
      if (sessions.length > 200) sessions.splice(0, sessions.length - 200);
      write(KEYS.SESSIONS, sessions);
    },

    count() {
      return this.all().length;
    },

    forSet(setId) {
      return this.all().filter(s => s.setId === setId);
    },
  };

  /* ---- META (streak, global stats) ---- */

  const Meta = {
    get() {
      return read(KEYS.META) || {
        streak: 0, bestStreak: 0, lastStudyDate: null, totalCardsStudied: 0,
      };
    },

    _save(m) { write(KEYS.META, m); },

    incrementCardsStudied() {
      const m = this.get();
      m.totalCardsStudied = (m.totalCardsStudied || 0) + 1;
      this._save(m);
    },

    recordStudyDay() {
      const m = this.get();
      const today = todayStr();
      if (m.lastStudyDate === today) return; // already counted today
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (m.lastStudyDate === yesterday) {
        m.streak = (m.streak || 0) + 1;
      } else if (m.lastStudyDate !== today) {
        m.streak = 1;
      }
      m.bestStreak = Math.max(m.streak, m.bestStreak || 0);
      m.lastStudyDate = today;
      this._save(m);
    },
  };

  /* ---- Public API ---- */
  return { init, Sets, Progress, Sessions, Meta, _uuid: uuid };

})();