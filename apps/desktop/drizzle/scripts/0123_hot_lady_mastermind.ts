function run(db) {
  const columns = db.prepare('PRAGMA table_info(orca_teams)').all();
  if (columns.length && !columns.some((column) => column.name === 'result_policy')) {
    db.exec("ALTER TABLE orca_teams ADD result_policy text DEFAULT 'default' NOT NULL");
  }
}

module.exports = { run };
