const RETIRED_MESSAGE = [
  'Legacy dispatch service retired.',
  'Use server/routes/dispatch.js or server/routes/admin-dispatch.js,',
  'which read canonical scheduled_services, technicians, and tech_status.',
].join(' ');

function retired(name) {
  const fn = async () => {
    throw new Error(`${name}: ${RETIRED_MESSAGE}`);
  };
  return fn;
}

function retiredSync(name) {
  return () => {
    throw new Error(`${name}: ${RETIRED_MESSAGE}`);
  };
}

module.exports = {
  RETIRED_MESSAGE,
  retired,
  retiredSync,
};
