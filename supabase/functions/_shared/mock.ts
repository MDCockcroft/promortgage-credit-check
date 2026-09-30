// MM_MODE=mock — a fake fetch that answers like the vendor, so the whole app can be built and
// demoed with zero vendor calls. Bodies are modelled on real UAT captures (uat-probe-results.md);
// the IDV and credit-report bodies are schema-faithful synthetics (no real person's data).
// Routing goes through callVendor unchanged, so mock mode exercises the real parsers.

const PDF_BASE64 = btoa("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

export const MOCK_QUESTIONS = {
  verificationRequestNumber: "MOCK-VRN-0001",
  responseCode: "Success",
  responseMessage: "Questions returned",
  questions: [
    {
      questionNumber: "1",
      questionText: "Which of these institutions do you hold a vehicle finance account with?",
      possibleAnswers: [
        { value: "1", label: "WesBank" },
        { value: "2", label: "MFC" },
        { value: "3", label: "Toyota Financial Services" },
        { value: "4", label: "None of the above" },
      ],
    },
    {
      questionNumber: "2",
      questionText: "In which suburb have you previously lived?",
      possibleAnswers: [
        { value: "1", label: "Brooklyn" },
        { value: "2", label: "Menlyn" },
        { value: "3", label: "Centurion" },
        { value: "4", label: "None of the above" },
      ],
    },
    {
      questionNumber: "3",
      questionText: "What is the approximate monthly instalment on your home loan?",
      possibleAnswers: [
        { value: "1", label: "R0 – R5,000" },
        { value: "2", label: "R5,001 – R10,000" },
        { value: "3", label: "R10,001 – R15,000" },
        { value: "4", label: "I do not have a home loan" },
      ],
    },
  ],
};

export const MOCK_REPORT = {
  type: "Full",
  errorCode: null,
  errorString: null,
  groupId: "MOCK-GROUP-0001",
  idNumber: null,
  experianCreditCheckReturnData: null,
  experianCCRReturnData: null,
  experianCreditCheckData: {
    cC_ENQUIRY_ID: "MOCK-ENQ-0001",
    credits: 0,
    ontrace: false,
    paymenthist: true,
    cC_RESULTS: {
      enqCC_CompuSCORE: [{
        score: "642", risK_TYPE: "Medium", risK_COLOUR_R: "255", risK_COLOUR_G: "191", risK_COLOUR_B: "0",
        thiN_FILE_INDICATOR: "N", declinE_R_1: "", declinE_R_2: "", declinE_R_3: "", declinE_R_4: "",
        declinE_R_5: "", scorE_TYPE: "Compuscore", version: "1",
      }],
      enqCC_JUDGEMENTS: [],
      enqCC_ADVERSE: [],
      enqCC_PUBLIC_DEFAULTS: [],
      enqCC_DEBT_RESTRUCT: [],
      enqCC_NOTICES: [],
      enqCC_COLLECTIONS: [],
      enqCC_ENQ_COUNTS: [],
      enqCC_ADDRESS: [],
      enqCC_EMPLOYER: [],
      nlR_SUMMARY: null,
    },
  },
  affordabilityResponseModel: {
    success: true, error: null, score: "642", amount: "1450000", ragIndicator: "Amber",
    deceased: "N", fraud: "N", dispute: "N", thinFile: "N", sequestration: "N",
    debtReview: "N", debtReviewRequested: "N", debtReviewGranted: "N",
    judgements: "no", adverse: "no", arrears: "0", notices: "no", monthsInArrears: 0, overdueBalances: 0,
    numberAdverseJudgements1Year: 0, numberJudgementsLast5Years: 0, consentWasGiven: true,
    creditStatusIndicator: null, creditClassification: "Acceptable", // shapes as seen in live UAT 2026-09-28
  },
};

/** Mock consent register, per isolate: personId → consentTypeId(lowercase) → record. */
const mockConsents = new Map<string, Map<string, Record<string, unknown>>>();

function reply(status: number, body: unknown, contentType = "application/json"): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": contentType } });
}

/** Behaves like the vendor for the nine allow-listed paths. */
export const mockFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  // The Entra token request (when MMAX_OAUTH_* are set) comes here too in mock mode. Its body is
  // form-encoded, not JSON, so answer it before parsing. expires_in 60 means the token is never
  // reused from the cache, so a mock token can never reach the real vendor after a switch to live.
  if (url.hostname === "login.microsoftonline.com") {
    return Promise.resolve(reply(200, { token_type: "Bearer", expires_in: 60, access_token: "mock-token" }));
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const p = url.pathname.replace(/^\/(CreditManagement\/v1|ConsentManagement\/v3)/, "");
  const body = init?.body ? JSON.parse(String(init.body)) : {};

  if (method === "POST" && p === "/Consents") {
    // Replace-on-write per (personId, consentTypeId), like the real vendor (P11).
    const recs = mockConsents.get(body.personId) ?? new Map<string, Record<string, unknown>>();
    for (const c of body.consents ?? []) {
      recs.set(String(c.consentTypeId).toLowerCase(), {
        id: `MOCK-${crypto.randomUUID().slice(0, 8)}`, consentTypeId: c.consentTypeId,
        consentTypeSnapshot: { name: "Broad consent MM", version: "13" },
        granted: c.granted === true, context: c.context ?? {}, createdDate: new Date().toISOString(),
      });
    }
    mockConsents.set(body.personId, recs);
    return Promise.resolve(reply(201, body.personId, "text/plain"));
  }
  if (method === "GET" && p === "/Consents") {
    // mm-client and mm-staff run in separate isolates, so a person this isolate has never seen is
    // assumed registered+granted (otherwise every mock check would be refused). What THIS isolate
    // wrote — e.g. a withdrawal — is returned as written (replace-on-write, P11).
    const recs = mockConsents.get(url.searchParams.get("PersonId") ?? "");
    return Promise.resolve(reply(200, recs ? [...recs.values()] : [{
      id: "MOCK-CONSENT-0001", consentTypeId: "818BB417-0963-4DFF-B7E3-09C66F6D0AF9",
      consentTypeSnapshot: { name: "Broad consent MM", version: "13" },
      granted: true, context: {}, createdDate: new Date().toISOString(),
    }]));
  }
  if (method === "POST" && p === "/Idv/getQuestions") return Promise.resolve(reply(200, MOCK_QUESTIONS));
  if (method === "POST" && p === "/Idv/checkAnswers") {
    // Mock rule: answering "4" to every question fails; anything else passes.
    const allFour = Array.isArray(body.answers) && body.answers.every((a: { answerNumber: string }) => a.answerNumber === "4");
    return Promise.resolve(reply(200, allFour
      // Shapes as seen in live UAT (2026-09-29): a failed check ALSO says success/TSCR — only the score differs.
      ? { success: true, errorCode: null, errorCodeDescription: null, responseStatus: "Success", statusCode: "TSCR",
        statusCodeDescription: "Transaction Status Completed with Results", finalScoreSpecified: true, finalScore: "20.00" }
      : { success: true, errorCode: null, errorCodeDescription: null, responseStatus: "Success", statusCode: "TSCR",
        statusCodeDescription: "Transaction Status Completed with Results", finalScoreSpecified: true, finalScore: "100.00" }));
  }
  if (method === "POST" && p === "/CreditCheck/full") return Promise.resolve(reply(200, MOCK_REPORT));
  if (method === "GET" && p.startsWith("/CreditCheck/getDocument/")) {
    return Promise.resolve(reply(200, JSON.stringify(PDF_BASE64)));
  }
  return Promise.resolve(reply(404, "mock: no route", "text/plain"));
};
