'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

function billedOrder(items, coupon) {
  var billed = pricing.computeTotals(items, coupon);
  var db = { nextOrderId: 1001, orders: [] };
  var order = orders.add(db, {
    date: '17/11/2021',
    items: items,
    coupon: coupon,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  });
  return { db: db, order: order, billed: billed };
}

test('invoice total and GST breakdown match a mixed-rate order billed with a capped coupon', function () {
  var fixture = billedOrder([
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(fixture.order);

  assert.deepEqual({
    total: figures.total,
    tax: figures.tax,
    cgst: figures.cgst,
    sgst: figures.sgst,
    lines: figures.rows.map(function (row) {
      return [row.gstPercent, row.lineTax];
    })
  }, {
    total: 2007.25,
    tax: 157.25,
    cgst: 78.63,
    sgst: 78.62,
    lines: [[5, 46.25], [12, 111]]
  });
});

test('invoice matches checkout for a full-price item at the default GST rate', function () {
  var fixture = billedOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(fixture.order);
  assert.equal(fixture.order.total, 236);
  assert.equal(figures.total, 236);
  assert.equal(figures.tax, 36);
  assert.equal(figures.cgst, 18);
  assert.equal(figures.sgst, 18);
  assert.doesNotMatch(invoice.render(fixture.order), /Accountant Reconciliation Notice/);
});

test('invoice uses the HSN slab when a saved line has no GST rate', function () {
  var fixture = billedOrder([{ name: 'Rice', hsn: '1006', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(fixture.order);
  assert.equal(fixture.billed.lines[0].gstPercent, 5);
  assert.equal(fixture.order.tax, 10);
  assert.equal(fixture.order.total, 210);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 10);
  assert.equal(figures.tax, 10);
  assert.equal(figures.total, 210);
});

test('printed invoice and reconciliation agree with checkout for a capped coupon', function () {
  var fixture = billedOrder([
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');
  assert.equal(fixture.order.discount, 150);
  var html = invoice.render(fixture.order);
  assert.match(html, /Taxable Amount<\/th>/);
  assert.match(html, /₹925\.00<\/td><td class="r">5%<\/td><td class="r">₹46\.25/);
  assert.match(html, /₹925\.00<\/td><td class="r">12%<\/td><td class="r">₹111\.00/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td class="r"[^>]*>-₹150\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  var reconciliation = reports.getGstReconciliation(fixture.db);
  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.deepEqual(reconciliation.rows[0], {
    orderId: 1001,
    date: '17/11/2021',
    customer: 'Walk-in',
    coupon: 'SAVE10',
    ledgerSubtotal: 2000,
    ledgerDiscount: 150,
    ledgerTax: 157.25,
    ledgerTotal: 2007.25,
    invoiceDiscount: 150,
    invoiceTax: 157.25,
    invoiceTotal: 2007.25,
    delta: 0,
    matched: true
  });
});

test('invoice GST sums the rounded line taxes used by checkout', function () {
  var fixture = billedOrder([
    { name: 'Item A', price: 0.03, qty: 1 },
    { name: 'Item B', price: 0.03, qty: 1 }
  ]);
  var figures = invoice.computeInvoiceFigures(fixture.order);

  assert.equal(fixture.order.tax, 0.02);
  assert.equal(fixture.order.total, 0.08);
  assert.deepEqual(figures.rows.map(function (row) {
    return row.lineTax;
  }), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.08);
});

test('invoice shows the rounding adjustment when taxable lines do not sum to the billed taxable amount', function () {
  var fixture = billedOrder([
    { name: 'Item A', price: 10.10, qty: 1 },
    { name: 'Item B', price: 10.10, qty: 1 },
    { name: 'Item C', price: 10.10, qty: 1 }
  ], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(fixture.order);
  assert.equal(figures.total, fixture.order.total);
  assert.equal(figures.tax, fixture.order.tax);
  var itemTable = invoice.render(fixture.order).split('</tbody>')[0];
  assert.match(itemTable, /Taxable rounding adjustment<\/td><td class="r">\+₹0\.01/);
});

test('CURRENT BEHAVIOUR: a GST-only discrepancy is reported without an invoice notice', function () {
  var fixture = billedOrder([{ name: 'Tea', price: 100, qty: 1 }]);
  // A previously saved order can carry the same total with a different tax amount.
  fixture.order.tax = 17;
  assert.equal(invoice.computeInvoiceFigures(fixture.order).tax, 18);
  assert.doesNotMatch(invoice.render(fixture.order), /Accountant Reconciliation Notice/);

  var reconciliation = reports.getGstReconciliation(fixture.db);
  assert.equal(reconciliation.mismatchCount, 1);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].matched, false);
});
