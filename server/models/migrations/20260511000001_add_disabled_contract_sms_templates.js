exports.up = async function up() {
  // Disabled contract SMS placeholders were retired before they were wired to a sender.
};

exports.down = async function down() {
  // Do not recreate retired placeholder SMS templates.
};
