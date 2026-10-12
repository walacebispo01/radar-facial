const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSnapshot,
  isMercadoPagoPaymentId,
  isInfinitePayPaymentId,
} = require("../lib/commission-program");

function seller(percentual) {
  return [{
    id: "seller",
    parent_id: null,
    status: "ativo",
    percentual: String(percentual),
  }];
}

test("comissão-base da venda própria fica entre 10% e 30%", () => {
  assert.throws(() => buildSnapshot("100", seller("9.99")));
  assert.equal(buildSnapshot("100", seller("10")).comissao_base, "10.000000");
  assert.equal(buildSnapshot("100", seller("30")).comissao_base, "30.000000");
  assert.throws(() => buildSnapshot("100", seller("30.01")));
});

test("identificadores financeiros distinguem Mercado Pago e InfinitePay", () => {
  assert.equal(isMercadoPagoPaymentId("123456789012"), true);
  assert.equal(isMercadoPagoPaymentId("123"), false);
  assert.equal(isInfinitePayPaymentId("ip_" + "a".repeat(64)), true);
  for (const value of ["ip_fake", "pix_fake", "subscription_fake", "", null]) {
    assert.equal(isMercadoPagoPaymentId(value), false);
    assert.equal(isInfinitePayPaymentId(value), false);
  }
});
