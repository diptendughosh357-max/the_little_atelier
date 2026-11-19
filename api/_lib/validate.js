'use strict';
const { HttpError } = require('./http');

const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal'
];

// Indian mobile: 10 digits starting 6-9. Accepts +91 / 91 / 0 prefixes and spaces or dashes.
function normMobile(v) {
  let d = String(v == null ? '' : v).replace(/[\s\-()]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function validPin(v) { return /^[1-9]\d{5}$/.test(String(v == null ? '' : v).trim()); }
function validEmail(v) { return v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

// Returns a clean customer object or throws 400 with a "fields" map the page can show.
function validateCustomer(c) {
  c = c && typeof c === 'object' ? c : {};
  const f = {};
  const name = clean(c.name, 80);
  const mobile = normMobile(c.mobile);
  const address = clean(c.address, 300);
  const city = clean(c.city, 60);
  const state = clean(c.state, 60);
  const pincode = clean(c.pincode, 6);
  const email = clean(c.email, 120);
  const landmark = clean(c.landmark, 100);
  const instructions = clean(c.instructions, 300);

  if (name.length < 2) f.name = 'Enter your full name';
  if (!mobile) f.mobile = 'Enter a valid 10-digit Indian mobile number';
  if (address.length < 10) f.address = 'Enter your full delivery address (house, street, area)';
  if (city.length < 2) f.city = 'Enter your city';
  if (!STATES.includes(state)) f.state = 'Choose your state';
  if (!validPin(pincode)) f.pincode = 'Enter a valid 6-digit PIN code';
  if (email && !validEmail(email)) f.email = 'Enter a valid email address or leave it blank';

  if (Object.keys(f).length) throw new HttpError(400, 'Please check the highlighted fields.', { fields: f });
  return { name, mobile, email, address, landmark, city, state, pincode, instructions };
}

module.exports = { STATES, normMobile, validPin, validEmail, clean, validateCustomer };
