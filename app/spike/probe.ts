print('probe: start');
console.log('probe: console.log works');
const env = process.env.SPIKE_CASE_DB;
print('probe: env=' + env);
setTimeout(() => print('probe: timer fired'), 100);
await new Promise((r) => setTimeout(r, 200));
print('probe: after await');
