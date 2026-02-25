import Database from "better-sqlite3";

export interface Entity {
  id: number;
  name: string;
  display_name: string;
  entity_type: string;
  created_at: string;
  updated_at: string;
}

export interface Triple {
  id: number;
  subject_id: number;
  predicate: string;
  object_id: number;
  confidence: number;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface Property {
  id: number;
  entity_id: number;
  key: string;
  value: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface HopResult {
  entity_id: number;
  depth: number;
  path: string;
  name?: string;
  entity_type?: string;
}

export interface EntityDetail {
  entity: Entity;
  triples: Array<{
    predicate: string;
    direction: "outgoing" | "incoming";
    related_name: string;
    related_type: string;
    confidence: number;
  }>;
  properties: Array<{ key: string; value: string }>;
}

export interface GraphStats {
  entity_count: number;
  triple_count: number;
  property_count: number;
  top_predicates: Array<{ predicate: string; count: number }>;
}

export interface TripleOpts {
  confidence?: number;
  source?: string;
}

export interface PropertyOpts {
  source?: string;
}

export interface PruneOpts {
  dryRun?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  entity_type TEXT DEFAULT 'unknown',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS triples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,
  object_id INTEGER NOT NULL REFERENCES entities(id),
  confidence REAL DEFAULT 1.0,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(subject_id, predicate, object_id)
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(entity_id, key)
);

CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject_id);
CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object_id);
CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
CREATE INDEX IF NOT EXISTS idx_properties_entity ON properties(entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(name, display_name, entity_type);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(name, display_name, entity_type) VALUES (new.name, new.display_name, new.entity_type);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE name = old.name;
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  DELETE FROM entities_fts WHERE name = old.name;
  INSERT INTO entities_fts(name, display_name, entity_type) VALUES (new.name, new.display_name, new.entity_type);
END;
`;

export class GraphDB {
  db: Database.Database;

  constructor(dbPath?: string) {
    this.db = dbPath ? new Database(dbPath) : new Database(":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.db.exec(FTS_SCHEMA);
    this.db.exec(FTS_TRIGGERS);
  }

  addEntity(name: string, type?: string): number {
    const canonical = name.toLowerCase().trim();
    const displayName = name.trim();
    const entityType = type || "unknown";

    const stmt = this.db.prepare(`
      INSERT INTO entities (name, display_name, entity_type)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        entity_type = CASE WHEN excluded.entity_type != 'unknown' THEN excluded.entity_type ELSE entities.entity_type END,
        display_name = CASE WHEN excluded.display_name != entities.name THEN excluded.display_name ELSE entities.display_name END,
        updated_at = datetime('now')
      RETURNING id
    `);

    const row = stmt.get(canonical, displayName, entityType) as { id: number };
    return row.id;
  }

  addTriple(
    subject: string,
    predicate: string,
    object: string,
    opts?: TripleOpts
  ): number {
    const subjectId = this.addEntity(subject);
    const objectId = this.addEntity(object);
    const confidence = opts?.confidence ?? 1.0;
    const source = opts?.source ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO triples (subject_id, predicate, object_id, confidence, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = datetime('now')
      RETURNING id
    `);

    const row = stmt.get(
      subjectId,
      predicate.toLowerCase().trim(),
      objectId,
      confidence,
      source
    ) as { id: number };
    return row.id;
  }

  addProperty(
    entity: string,
    key: string,
    value: string,
    opts?: PropertyOpts
  ): number {
    const entityId = this.addEntity(entity);
    const source = opts?.source ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO properties (entity_id, key, value, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_id, key) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        updated_at = datetime('now')
      RETURNING id
    `);

    const row = stmt.get(entityId, key, value, source) as { id: number };
    return row.id;
  }

  query(entityName: string, hops: number = 2): HopResult[] {
    const canonical = entityName.toLowerCase().trim();

    const stmt = this.db.prepare(`
      WITH RECURSIVE hops(entity_id, depth, path, visited) AS (
        SELECT id, 0, name, ',' || name || ','
        FROM entities WHERE name = ?
        UNION ALL
        SELECT
          CASE WHEN t.subject_id = h.entity_id THEN t.object_id ELSE t.subject_id END,
          h.depth + 1,
          h.path || ' -> ' || t.predicate || ' -> ' || e2.name,
          h.visited || e2.name || ','
        FROM hops h
        JOIN triples t ON t.subject_id = h.entity_id OR t.object_id = h.entity_id
        JOIN entities e2 ON e2.id = CASE WHEN t.subject_id = h.entity_id THEN t.object_id ELSE t.subject_id END
        WHERE h.depth < ? AND h.visited NOT LIKE '%,' || e2.name || ',%'
      )
      SELECT h.entity_id, h.depth, h.path, e.name, e.entity_type
      FROM hops h
      JOIN entities e ON e.id = h.entity_id
      ORDER BY h.depth
    `);

    return stmt.all(canonical, hops) as HopResult[];
  }

  search(text: string): Entity[] {
    const stmt = this.db.prepare(`
      SELECT e.*
      FROM entities_fts fts
      JOIN entities e ON e.name = fts.name
      WHERE entities_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `);

    // FTS5 query: escape special chars and add prefix matching
    const query = text
      .trim()
      .split(/\s+/)
      .map((w) => `"${w}"*`)
      .join(" ");

    try {
      return stmt.all(query) as Entity[];
    } catch {
      // Fallback to LIKE if FTS query fails
      const likeStmt = this.db.prepare(`
        SELECT * FROM entities WHERE name LIKE ? OR display_name LIKE ? LIMIT 20
      `);
      const pattern = `%${text.toLowerCase().trim()}%`;
      return likeStmt.all(pattern, pattern) as Entity[];
    }
  }

  getEntity(name: string): EntityDetail | null {
    const canonical = name.toLowerCase().trim();

    const entity = this.db.prepare("SELECT * FROM entities WHERE name = ?").get(canonical) as Entity | undefined;
    if (!entity) return null;

    const triples = this.db
      .prepare(
        `
      SELECT
        t.predicate,
        CASE WHEN t.subject_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
        CASE WHEN t.subject_id = ? THEN eo.display_name ELSE es.display_name END as related_name,
        CASE WHEN t.subject_id = ? THEN eo.entity_type ELSE es.entity_type END as related_type,
        t.confidence
      FROM triples t
      JOIN entities es ON es.id = t.subject_id
      JOIN entities eo ON eo.id = t.object_id
      WHERE t.subject_id = ? OR t.object_id = ?
    `
      )
      .all(entity.id, entity.id, entity.id, entity.id, entity.id) as EntityDetail["triples"];

    const properties = this.db
      .prepare("SELECT key, value FROM properties WHERE entity_id = ?")
      .all(entity.id) as EntityDetail["properties"];

    return { entity, triples, properties };
  }

  merge(entity1: string, entity2: string): void {
    const name1 = entity1.toLowerCase().trim();
    const name2 = entity2.toLowerCase().trim();

    const e1 = this.db.prepare("SELECT * FROM entities WHERE name = ?").get(name1) as Entity | undefined;
    const e2 = this.db.prepare("SELECT * FROM entities WHERE name = ?").get(name2) as Entity | undefined;

    if (!e1 || !e2) {
      throw new Error(`Entity not found: ${!e1 ? entity1 : entity2}`);
    }

    // Keep e1 as the primary entity. Reassign all of e2's triples and properties.
    const mergeOp = this.db.transaction(() => {
      // Update triples where e2 is subject
      this.db
        .prepare(
          `UPDATE OR IGNORE triples SET subject_id = ?, updated_at = datetime('now') WHERE subject_id = ?`
        )
        .run(e1.id, e2.id);

      // Update triples where e2 is object
      this.db
        .prepare(
          `UPDATE OR IGNORE triples SET object_id = ?, updated_at = datetime('now') WHERE object_id = ?`
        )
        .run(e1.id, e2.id);

      // Delete any remaining triples that reference e2 (duplicates from merge)
      this.db.prepare("DELETE FROM triples WHERE subject_id = ? OR object_id = ?").run(e2.id, e2.id);

      // Move properties
      this.db
        .prepare(
          `UPDATE OR IGNORE properties SET entity_id = ?, updated_at = datetime('now') WHERE entity_id = ?`
        )
        .run(e1.id, e2.id);

      // Delete remaining duplicate properties
      this.db.prepare("DELETE FROM properties WHERE entity_id = ?").run(e2.id);

      // Store the alias as a property
      this.addProperty(name1, "alias", e2.display_name);

      // Delete e2
      this.db.prepare("DELETE FROM entities WHERE id = ?").run(e2.id);
    });

    mergeOp();
  }

  prune(opts?: PruneOpts): string[] {
    const orphans = this.db
      .prepare(
        `
      SELECT e.name FROM entities e
      WHERE NOT EXISTS (SELECT 1 FROM triples t WHERE t.subject_id = e.id OR t.object_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.entity_id = e.id)
    `
      )
      .all() as Array<{ name: string }>;

    const names = orphans.map((o) => o.name);

    if (!opts?.dryRun && names.length > 0) {
      const deleteStmt = this.db.prepare("DELETE FROM entities WHERE name = ?");
      const deleteOp = this.db.transaction(() => {
        for (const name of names) {
          deleteStmt.run(name);
        }
      });
      deleteOp();
    }

    return names;
  }

  stats(): GraphStats {
    const entityCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM entities").get() as {
        count: number;
      }
    ).count;
    const tripleCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM triples").get() as {
        count: number;
      }
    ).count;
    const propertyCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM properties").get() as {
        count: number;
      }
    ).count;
    const topPredicates = this.db
      .prepare(
        `
      SELECT predicate, COUNT(*) as count
      FROM triples
      GROUP BY predicate
      ORDER BY count DESC
      LIMIT 10
    `
      )
      .all() as Array<{ predicate: string; count: number }>;

    return {
      entity_count: entityCount,
      triple_count: tripleCount,
      property_count: propertyCount,
      top_predicates: topPredicates,
    };
  }

  exportAll(): {
    entities: Entity[];
    triples: Array<Triple & { subject_name: string; object_name: string }>;
    properties: Array<Property & { entity_name: string }>;
  } {
    const entities = this.db.prepare("SELECT * FROM entities").all() as Entity[];
    const triples = this.db
      .prepare(
        `
      SELECT t.*, es.name as subject_name, eo.name as object_name
      FROM triples t
      JOIN entities es ON es.id = t.subject_id
      JOIN entities eo ON eo.id = t.object_id
    `
      )
      .all() as Array<Triple & { subject_name: string; object_name: string }>;
    const properties = this.db
      .prepare(
        `
      SELECT p.*, e.name as entity_name
      FROM properties p
      JOIN entities e ON e.id = p.entity_id
    `
      )
      .all() as Array<Property & { entity_name: string }>;

    return { entities, triples, properties };
  }

  importData(data: {
    entities?: Array<{ name: string; type?: string }>;
    triples?: Array<{
      subject: string;
      predicate: string;
      object: string;
      confidence?: number;
      source?: string;
    }>;
    properties?: Array<{
      entity: string;
      key: string;
      value: string;
      source?: string;
    }>;
  }): void {
    const importOp = this.db.transaction(() => {
      if (data.entities) {
        for (const e of data.entities) {
          this.addEntity(e.name, e.type);
        }
      }
      if (data.triples) {
        for (const t of data.triples) {
          this.addTriple(t.subject, t.predicate, t.object, {
            confidence: t.confidence,
            source: t.source,
          });
        }
      }
      if (data.properties) {
        for (const p of data.properties) {
          this.addProperty(p.entity, p.key, p.value, { source: p.source });
        }
      }
    });
    importOp();
  }

  close(): void {
    this.db.close();
  }
}
