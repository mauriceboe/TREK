# Budget Tracking

Track trip expenses by category, split costs between members, and visualize spending.

<!-- TODO: screenshot: budget summary and expense list -->

![Budget panel](assets/Budget.png)

## Where to find it

Open the **Budget** tab inside the trip planner. The tab is only visible when the Budget addon is enabled.

> **Admin:** Budget is an addon. Enable it in [Admin-Addons](Admin-Addons).

![Create Budget](assets/BudgetCreateBudget.gif)

## Currency

Use the currency picker in the Budget toolbar to select one currency for the entire trip. 46 currencies are supported (EUR, USD, GBP, JPY, CHF, CZK, PLN, SEK, NOK, DKK, TRY, THB, AUD, CAD, NZD, BRL, MXN, INR, IDR, MYR, PHP, SGD, KRW, CNY, HKD, TWD, ZAR, AED, SAR, ILS, EGP, MAD, HUF, RON, BGN, HRK, ISK, RUB, UAH, BDT, LKR, VND, CLP, COP, PEN, ARS). All amounts are displayed in this currency.

## Categories

Expenses are grouped into categories. Each category is shown with a small colored square indicator that cycles through a 12-color palette as you add more categories.

From the toolbar you can:

- **Add a category** — type a name and click the **+** button (or press Enter).
- **Rename a category** — click the pencil icon next to its name in the category header.
- **Reorder categories** — drag the grip handle on the left of the category header.
- **Delete a category** — click the trash icon in the category header. This deletes all expense items inside it.

## Expense items

Each category contains a table of items with the following columns:

| Column | Notes |
|---|---|
| Name | Editable inline. Read-only when linked to a reservation. |
| Total | The total cost for this item. |
| Persons | Number of persons (or member chips on multi-member trips). |
| Days | Number of days. |
| Per Person | Calculated: Total ÷ Persons. |
| Per Day | Calculated: Total ÷ Days. |
| Per Person/Day | Calculated: Total ÷ (Persons × Days). |
| Date | Optional expense date. |
| Note | Free-text note. |

Click any editable cell to edit it inline. Drag the grip handle to reorder items within a category.

Add a new item using the inline **add row** at the bottom of each category table.

## Splitting costs

The **Persons** column behaves differently depending on the trip:

- **Single-user trip** — enter a number of persons directly.
- **Multi-member trip** — a member chip picker appears. Click the edit button to assign or remove members from an expense. Click an assigned member chip again to mark them as **paid** (the chip shows a green ring).

![Add Expense](assets/BudgetAddExpensive.gif)

## Settlement calculator

When multiple members are assigned to expenses and there are outstanding debts between members, a collapsible **Settlement** section appears inside the total card. Click the section header to expand it. It shows the minimum number of transfers needed to settle all debts (using a greedy matching algorithm), including:

- Transfer flows: who pays whom and how much.
- Net balances: each member's overall surplus or deficit.

![Final Settlement](assets/BudgetFinalSettlement.gif)

## Budget summary

The right-hand column contains two widgets:

- **Total card** — displays the grand total in large type. On multi-member trips it also shows a per-member breakdown with a proportional bar.
- **Donut chart** — spending by category. Each segment uses that category's color. The legend always shows the amount and percentage for each category; hovering a legend row highlights it.

## Exporting

Click the **CSV** button in the toolbar to download a semicolon-delimited file containing all categories and items. The columns exported are: Category, Name, Date, Total, Persons, Days, Per Person, Per Day, Per Person/Day, Note.

## Permissions

All write operations (adding/editing/deleting items and categories, changing currency) require the `budget_edit` permission.

## See also

- [Admin-Addons](Admin-Addons)
- [Reservations-and-Bookings](Reservations-and-Bookings)
- [Trip-Planner-Overview](Trip-Planner-Overview)
