var rate = 0.1;

function total(a, b) {
  return (a + b) * (1 + rate);
}

module.exports = { total, rate };
