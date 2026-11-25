## Session 1: server 1.0.0

**Prompt:** Using the invoices server, how much does customer cus_007 owe in unpaid invoices?

**Tools the model had:** `change_requests_confirm`, `change_requests_get`, `change_requests_list`, `change_requests_scorecard`, `change_requests_submit`, `change_requests_withdraw`, `list_invoices`

**Call** `list_invoices`

```json
{}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0001","customer_id":"cus_001","amount":100,"status":"unpaid"},{"id":"inv_0002","customer_id":"cus_002","amount":137,"status":"paid"},{"id":"inv_0003","customer_id":"cus_003","amount":174,"status":"paid"},{"id":"inv_0004","customer_id":"cus_004","amount":211,"status":"unpaid"},{"id":"inv_0005","customer_id":"cus_005","amount":248,"status":"paid"},{"id":"inv_0006","customer_id":"cus_006","amount":285,"status":"paid"},{"id":"inv_0007","customer_id":"cus_007","amount":322,"status":"unpaid"},{"id":"inv_0008","customer_id":"cus_008","amount":359,"status":"paid"},{"id":"inv_00… (3616 characters in all)
```

**Call** `list_invoices`

```json
{
  "cursor": "50"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0051","customer_id":"cus_011","amount":150,"status":"paid"},{"id":"inv_0052","customer_id":"cus_012","amount":187,"status":"unpaid"},{"id":"inv_0053","customer_id":"cus_013","amount":224,"status":"paid"},{"id":"inv_0054","customer_id":"cus_014","amount":261,"status":"paid"},{"id":"inv_0055","customer_id":"cus_015","amount":298,"status":"unpaid"},{"id":"inv_0056","customer_id":"cus_016","amount":335,"status":"paid"},{"id":"inv_0057","customer_id":"cus_017","amount":372,"status":"paid"},{"id":"inv_0058","customer_id":"cus_018","amount":409,"status":"unpaid"},{"id":"inv_00… (3617 characters in all)
```

**Call** `list_invoices`

```json
{
  "cursor": "100"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0101","customer_id":"cus_001","amount":200,"status":"paid"},{"id":"inv_0102","customer_id":"cus_002","amount":237,"status":"paid"},{"id":"inv_0103","customer_id":"cus_003","amount":274,"status":"unpaid"},{"id":"inv_0104","customer_id":"cus_004","amount":311,"status":"paid"},{"id":"inv_0105","customer_id":"cus_005","amount":348,"status":"paid"},{"id":"inv_0106","customer_id":"cus_006","amount":385,"status":"unpaid"},{"id":"inv_0107","customer_id":"cus_007","amount":422,"status":"paid"},{"id":"inv_0108","customer_id":"cus_008","amount":459,"status":"paid"},{"id":"inv_0109… (3615 characters in all)
```

**Call** `list_invoices`

```json
{
  "cursor": "150"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0151","customer_id":"cus_011","amount":250,"status":"unpaid"},{"id":"inv_0152","customer_id":"cus_012","amount":287,"status":"paid"},{"id":"inv_0153","customer_id":"cus_013","amount":324,"status":"paid"},{"id":"inv_0154","customer_id":"cus_014","amount":361,"status":"unpaid"},{"id":"inv_0155","customer_id":"cus_015","amount":398,"status":"paid"},{"id":"inv_0156","customer_id":"cus_016","amount":435,"status":"paid"},{"id":"inv_0157","customer_id":"cus_017","amount":472,"status":"unpaid"},{"id":"inv_0158","customer_id":"cus_018","amount":509,"status":"paid"},{"id":"inv_01… (3617 characters in all)
```

**Call** `list_invoices`

```json
{
  "cursor": "200"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0201","customer_id":"cus_001","amount":300,"status":"paid"},{"id":"inv_0202","customer_id":"cus_002","amount":337,"status":"unpaid"},{"id":"inv_0203","customer_id":"cus_003","amount":374,"status":"paid"},{"id":"inv_0204","customer_id":"cus_004","amount":411,"status":"paid"},{"id":"inv_0205","customer_id":"cus_005","amount":448,"status":"unpaid"},{"id":"inv_0206","customer_id":"cus_006","amount":485,"status":"paid"},{"id":"inv_0207","customer_id":"cus_007","amount":522,"status":"paid"},{"id":"inv_0208","customer_id":"cus_008","amount":559,"status":"unpaid"},{"id":"inv_02… (2164 characters in all)
```

**Call** `change_requests_submit`

```json
{
  "kind": "feature_request",
  "title": "list_invoices: add customer_id and status filters",
  "description": "To answer \"how much does one customer owe in unpaid invoices\", list_invoices has no filters, so I had to page through every invoice (5 pages of 50) and filter and sum on the client side. Please add optional customer_id and status filters to list_invoices. A returned total amount for the filtered set would also help.",
  "idempotencyKey": "b1f3c2a8-7d44-4e0b-9a61-invfilter-cus-status-001",
  "failureMode": "interface_cost",
  "target": {
    "type": "tool",
    "name": "list_invoices"
  },
  "impact": {
    "blocked": false,
    "severity": "low",
    "frequency": "recurring",
    "detectability": "immediate"
  },
  "context": {
    "goal": "Sum unpaid invoice amounts for a single customer",
    "workaround": "Paged through all invoices and filtered client-side"
  },
  "acceptanceTests": [
    {
      "description": "Filter by customer and status returns only matching invoices",
      "call": {
        "method": "tools/call",
        "params": {
          "name": "list_invoices",
          "arguments": {
            "customer_id": "cus_example",
            "status": "unpaid"
          }
        }
      },
      "expect": {
        "isError": false,
        "textContains": [
          "cus_example",
          "unpaid"
        ]
      }
    }
  ]
}
```

**Result, as the model saw it**

```json
{"requestId":"crq_f962aeaec7554f2d","status":"received","duplicateOf":null,"demand":1}
```

**Claude:**

> Customer **cus_007 owes $2,008** across 4 unpaid invoices:
> 
> | Invoice | Amount |
> |---|---|
> | inv_0007 | $322 |
> | inv_0067 | $742 |
> | inv_0127 | $262 |
> | inv_0187 | $682 |
> | **Total** | **$2,008** |
> 
> There are 230 invoices on 5 pages, and I checked all of them. cus_007 has 8 other invoices, all paid.
> 
> `list_invoices` can't filter by customer or status, so I had to read every page to get this. I sent a feature request to the invoices server asking for those filters (request ID `crq_f962aeaec7554f2d`). It includes no customer data.

## The vendor ships 1.1.0

`node packages/demo/dist/ship.js`:

```
Shipped crq_f962aeaec7554f2d in 1.1.0.
```

## Session 2: server 1.1.0

**Prompt:** Using the invoices server, how much does customer cus_012 owe in unpaid invoices?

**Tools the model had:** `change_requests_confirm`, `change_requests_get`, `change_requests_list`, `change_requests_scorecard`, `change_requests_submit`, `change_requests_withdraw`, `list_invoices`

**Call** `list_invoices`

```json
{
  "customer_id": "cus_012",
  "status": "unpaid"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0052","customer_id":"cus_012","amount":187,"status":"unpaid"},{"id":"inv_0112","customer_id":"cus_012","amount":607,"status":"unpaid"},{"id":"inv_0172","customer_id":"cus_012","amount":127,"status":"unpaid"}]}
```

Not shown to the model: `_meta` `{"com.rocketproforma/change-requests":{"updates":1}}`

**Claude:**

> Customer **cus_012** owes **921** across 3 unpaid invoices:
> 
> | Invoice | Amount |
> |---|---|
> | inv_0052 | 187 |
> | inv_0112 | 607 |
> | inv_0172 | 127 |
> | **Total** | **921** |
> 
> The server sent back a single page with no cursor for more, so these are all of them. It didn't include a currency or due dates, so I can't say which currency this is or whether any invoice is overdue.

## Session 3: server 1.1.0

**Prompt:** Using the invoices server, how much does customer cus_012 owe in unpaid invoices?

**Added to the system prompt:** Memory from earlier sessions: on the invoices server you filed change request crq_f962aeaec7554f2d (list_invoices could not filter by customer or status; workaround: page through every invoice and filter locally).

**Tools the model had:** `change_requests_confirm`, `change_requests_get`, `change_requests_list`, `change_requests_scorecard`, `change_requests_submit`, `change_requests_withdraw`, `list_invoices`

**Call** `list_invoices`

```json
{
  "customer_id": "cus_012",
  "status": "unpaid"
}
```

**Call** `change_requests_get`

```json
{
  "requestId": "crq_f962aeaec7554f2d"
}
```

**Result, as the model saw it**

```json
{"invoices":[{"id":"inv_0052","customer_id":"cus_012","amount":187,"status":"unpaid"},{"id":"inv_0112","customer_id":"cus_012","amount":607,"status":"unpaid"},{"id":"inv_0172","customer_id":"cus_012","amount":127,"status":"unpaid"}]}
```

Not shown to the model: `_meta` `{"com.rocketproforma/change-requests":{"updates":1}}`

**Result, as the model saw it**

```json
{"requestId":"crq_f962aeaec7554f2d","title":"list_invoices: add customer_id and status filters","kind":"feature_request","status":"shipped","origin":"agent","about":"app","updatedAt":"2026-11-25T14:16:56.228Z","demand":1,"message":"list_invoices now accepts customer_id and status.","resolution":{"availability":"all","changed":[{"type":"tool","name":"list_invoices"}],"workaroundObsolete":true,"tests":[{"index":0,"outcome":"pass"}]},"version":"1.1.0"}
```

**Claude:**

> Filters worked and returned only matching invoices, no next page. Confirming the shipped fix.

**Call** `change_requests_confirm`

```json
{
  "requestId": "crq_f962aeaec7554f2d",
  "outcome": "pass",
  "adopted": true,
  "note": "list_invoices with customer_id and status=unpaid returned only matching invoices in a single page. Dropped the page-through-and-filter-locally workaround."
}
```

**Result, as the model saw it**

```json
{"requestId":"crq_f962aeaec7554f2d","title":"list_invoices: add customer_id and status filters","kind":"feature_request","status":"shipped","origin":"agent","about":"app","updatedAt":"2026-11-25T14:18:12.345Z","demand":1,"message":"list_invoices now accepts customer_id and status.","resolution":{"availability":"all","changed":[{"type":"tool","name":"list_invoices"}],"workaroundObsolete":true,"tests":[{"index":0,"outcome":"pass"}]},"version":"1.1.0","confirmation":{"outcome":"pass","confirmedAt":"2026-11-25T14:18:12.345Z","adopted":true}}
```

**Claude:**

> Customer **cus_012 owes $921** across three unpaid invoices:
> 
> | Invoice | Amount |
> |---|---|
> | inv_0052 | $187 |
> | inv_0112 | $607 |
> | inv_0172 | $127 |
> | **Total** | **$921** |
> 
> The invoices server doesn't return a currency, so I've shown these as dollars. All three invoices came back on one page.
> 
> In an earlier session I asked the invoices server to let `list_invoices` filter by customer and by status (request crq_f962aeaec7554f2d). That change is now live, so I could ask for cus_012's unpaid invoices directly. Before, I had to go through every invoice and pick them out by hand. I told the server the change worked and that I've stopped using the workaround.
