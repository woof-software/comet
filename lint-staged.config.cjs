module.exports = {
  '{plugins,scenario,scripts,src,tasks,test}/**/*.{js,ts}': 'eslint',
  'hardhat.config.ts': 'eslint',
  'contracts/**/*.sol': 'solhint --fix',
};
