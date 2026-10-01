/**
 * FlatOut NZ — tenant quote form → Google Sheet
 * ---------------------------------------------------------------
 * UPDATED 1 October 2026.
 *
 * What's new in this version:
 *  - Sends the customer a confirmation email with their reference
 *  - Optional alert email to you on every submission (off by default —
 *    see NOTIFY_OWNER below; worth turning on, reasons in the comment)
 *  - Returns a proper JSON result the website can actually read, so a
 *    failed submission shows an error instead of a false thank-you
 *
 * SETUP — do these in order:
 *  1. Add headers in columns Q, R, S of "Tenant responses":
 *     Reference | Terms version | Consented at
 *  2. Paste this whole file into Extensions > Apps Script (replacing
 *     what's there) and save.
 *  3. Deploy > Manage deployments > pencil icon > Version: New version
 *     > Deploy. This KEEPS your existing /exec URL, so the website
 *     needs no change. Creating a *new* deployment instead gives you a
 *     new URL and you'd have to update quote/index.html.
 *  4. Re-authorise when prompted — this version sends email, which is a
 *     permission the old one didn't need, so Google will ask again.
 */

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
var SHEET_NAME = 'Tenant responses';
// Note the DOUBLE space in the landlord tab name — that's how the tab is
// actually named in the sheet. Getting it wrong means getByName returns
// null and the submission is rejected.
var LANDLORD_SHEET_NAME = 'Landlord  property management';
var BUSINESS_EMAIL = 'admin@flatoutnz.co.nz';
var BUSINESS_PHONE = '027 408 6895';

// Send the customer a confirmation email with their reference number.
var EMAIL_CUSTOMER = true;

// Email you every time a request lands. Off because you didn't ask for
// it — but consider turning it on before November. It's the only thing
// that tells you a submission arrived without you watching the sheet,
// and it doubles as your check that the form is still working: no
// emails for two days in peak week means something is broken.
var NOTIFY_OWNER = false;
var OWNER_EMAIL = 'admin@flatoutnz.co.nz';

// Gmail caps consumer accounts at 100 recipients a day and Workspace at
// 1500. Nowhere near your volume, but if a send fails the row is still
// written — the submission is never lost because an email bounced.
// ---------------------------------------------------------------------

function doPost(e) {
  try {
    var data;
    var isJson = false;

    try {
      data = JSON.parse(e.postData.contents);
      isJson = true;
    } catch (parseErr) {
      data = e.parameter;
    }

    // Honeypot — hidden field filled means a bot. Look successful,
    // write nothing.
    if (data.website) {
      return jsonResponse({ result: 'success' });
    }

    var services = isJson && Array.isArray(data.services)
      ? data.services.join(', ')
      : (data.services || '');

    // Landlord enquiries go to their own tab with a different shape.
    if (data.formType === 'landlord') {
      return handleLandlord(data, services);
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('Sheet tab "' + SHEET_NAME + '" was not found.');
    }

    sheet.appendRow([
      new Date(),                          // A  Timestamp
      data.email || '',                    // B  Email address
      data.fullName || '',                 // C  Full Name
      data.phone || '',                    // D  Phone Number
      data.isStudent || '',                // E  Are you a student?
      data.moveDate || '',                 // F  When are you moving out?
      data.currentLocation || '',          // G  Current location
      data.movingTo || '',                 // H  Where are you moving to?
      data.moveFor || '',                  // I  Is this move for:
      services,                            // J  Which services do you need?
      data.bedrooms || '',                 // K  Bedrooms in current flat
      data.volume || '',                   // L  Approx. how much stuff
      data.specialRequirements || '',      // M  Special requirements
      data.hearAbout || '',                // N  How did you hear about us?
      data.contactMethod || '',            // O  Best way to contact you
      data.consent || '',                  // P  Consent
      data.reference || '',                // Q  Reference
      data.termsVersion || '',             // R  Terms version
      data.consentedAt || ''               // S  Consented at
    ]);

    // Emails are best-effort. The row is already saved, so a send
    // failure must never turn into a failed submission.
    if (EMAIL_CUSTOMER && data.email) {
      try { sendCustomerEmail(data, services); } catch (mailErr) {}
    }
    if (NOTIFY_OWNER) {
      try { sendOwnerEmail(data, services); } catch (mailErr) {}
    }

    return jsonResponse({ result: 'success', reference: data.reference || '' });

  } catch (error) {
    return jsonResponse({ result: 'error', message: error.toString() });
  }
}

function handleLandlord(data, services) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(LANDLORD_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet tab "' + LANDLORD_SHEET_NAME + '" was not found.');
  }

  sheet.appendRow([
    new Date(),                        // A  Timestamp
    data.email || '',                  // B  Email address
    data.fullName || '',               // C  Full Name / Company Name
    data.email || '',                  // D  Email Address
    data.phone || '',                  // E  Phone Number
    data.role || '',                   // F  Role
    data.propertyAddress || '',        // G  Property Address
    data.tenancyEnd || '',             // H  Tenancy End Date
    data.completionDate || '',         // I  Required Completion Date
    data.accessMethod || '',           // J  Property Access Method
    services,                          // K  Which services do you require?
    data.propertySize || '',           // L  Property Size
    data.condition || '',              // M  Current Property Condition
    data.specialRequirements || '',    // N  Special Requirements
    data.contactMethod || '',          // O  Preferred Contact Method
    data.consent || '',                // P  Authorization & Consent
    data.reference || '',              // Q  Reference
    data.termsVersion || '',           // R  Terms version
    data.consentedAt || ''             // S  Consented at
  ]);

  if (NOTIFY_OWNER) {
    try {
      MailApp.sendEmail({
        to: OWNER_EMAIL,
        subject: 'FlatOut LANDLORD enquiry: ' + (data.fullName || 'unknown') +
                 ' (' + (data.reference || '—') + ')',
        body: 'Landlord / property manager enquiry.\n\n' +
          'Reference: ' + (data.reference || '—') + '\n' +
          'Name: ' + (data.fullName || '—') + ' (' + (data.role || '—') + ')\n' +
          'Phone: ' + (data.phone || '—') + '\n' +
          'Email: ' + (data.email || '—') + '\n\n' +
          'Property: ' + (data.propertyAddress || '—') + '\n' +
          'Size: ' + (data.propertySize || '—') + '\n' +
          'Condition: ' + (data.condition || '—') + '\n' +
          'Access: ' + (data.accessMethod || '—') + '\n' +
          'Tenancy ends: ' + (data.tenancyEnd || '—') + '\n' +
          'Needed by: ' + (data.completionDate || '—') + '\n' +
          'Services: ' + (services || '—') + '\n\n' +
          'Notes: ' + (data.specialRequirements || '—'),
        name: 'FlatOut website'
      });
    } catch (e) {}
  }

  return jsonResponse({ result: 'success', reference: data.reference || '' });
}

function sendCustomerEmail(data, services) {
  var name = (data.fullName || '').split(' ')[0] || 'there';
  var ref = data.reference || '';

  var body =
    'Hi ' + name + ',\n\n' +
    'We\'ve got your move-out request. Your reference is ' + ref + ' — ' +
    'quote it if you call or text us and it saves you explaining ' +
    'everything again.\n\n' +
    'WHAT HAPPENS NEXT\n\n' +
    '1. We call you, usually the same day, to arrange a time to come ' +
    'and look at the job.\n' +
    '2. One of us comes to the flat and sees what\'s actually there. ' +
    'You get an estimate on the spot.\n' +
    '3. Once we\'ve locked in the people doing the work, we send you ' +
    'one written quote covering everything.\n' +
    '4. Accept it and we run the job — booking contractors, arranging ' +
    'access, keeping it on track.\n\n' +
    'The visit, the estimate and the quote are free. You\'re charged ' +
    'nothing until you\'ve accepted a written quote.\n\n' +
    'WHAT YOU TOLD US\n\n' +
    'Moving out of: ' + (data.currentLocation || '—') + '\n' +
    'Move-out date: ' + (data.moveDate || '—') + '\n' +
    'Services: ' + (services || '—') + '\n' +
    'Flat size: ' + (data.bedrooms || '—') + '\n\n' +
    'If any of that\'s wrong, just reply to this email.\n\n' +
    'Need us sooner? If your handover date is close, say so — call or ' +
    'text ' + BUSINESS_PHONE + ' and we\'ll move you up.\n\n' +
    'Daniel Bell\n' +
    'FlatOut NZ\n' +
    BUSINESS_PHONE + ' · ' + BUSINESS_EMAIL + '\n' +
    'flatoutnz.co.nz';

  MailApp.sendEmail({
    to: data.email,
    subject: 'Your FlatOut request — ' + ref,
    body: body,
    name: 'FlatOut NZ',
    replyTo: BUSINESS_EMAIL
  });
}

function sendOwnerEmail(data, services) {
  var body =
    'New move-out request.\n\n' +
    'Reference: ' + (data.reference || '—') + '\n' +
    'Name: ' + (data.fullName || '—') + '\n' +
    'Phone: ' + (data.phone || '—') + '\n' +
    'Email: ' + (data.email || '—') + '\n' +
    'Prefers: ' + (data.contactMethod || '—') + '\n\n' +
    'Moving out of: ' + (data.currentLocation || '—') + '\n' +
    'Moving to: ' + (data.movingTo || '—') + '\n' +
    'Date: ' + (data.moveDate || '—') + '\n' +
    'For: ' + (data.moveFor || '—') + '\n' +
    'Services: ' + (services || '—') + '\n' +
    'Bedrooms: ' + (data.bedrooms || '—') + '\n' +
    'Volume: ' + (data.volume || '—') + '\n' +
    'Student: ' + (data.isStudent || '—') + '\n' +
    'Heard via: ' + (data.hearAbout || '—') + '\n\n' +
    'Notes: ' + (data.specialRequirements || '—') + '\n\n' +
    'Agreed to terms ' + (data.termsVersion || '—') +
    ' at ' + (data.consentedAt || '—');

  MailApp.sendEmail({
    to: OWNER_EMAIL,
    subject: 'FlatOut request: ' + (data.fullName || 'unknown') +
             ' (' + (data.reference || '—') + ')',
    body: body,
    name: 'FlatOut website'
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Open the /exec URL in a browser to check the script is deployed and
// reachable. Writes nothing.
function doGet(e) {
  return jsonResponse({ status: 'FlatOut NZ quote form endpoint is live.' });
}

/**
 * Run this once from the editor (select it above and press Run) to send
 * yourself a test confirmation email without touching the sheet. Useful
 * for checking the wording before it goes to a real customer.
 */
function testCustomerEmail() {
  sendCustomerEmail({
    fullName: 'Test Student',
    email: OWNER_EMAIL,
    reference: 'FO-261001-0000',
    currentLocation: 'Ilam',
    moveDate: '2026-11-14',
    bedrooms: '4 bedrooms'
  }, 'Cleaning (end-of-lease deep clean), Rubbish (junk removal & disposal)');
}
