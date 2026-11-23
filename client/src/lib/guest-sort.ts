export type GuestSortField = "name" | "phone";

type SortableGuest = {
  id: string;
  name: string;
  phone: string;
  ticket: string;
};

const textCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function normalizedPhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function compareText(left: string, right: string): number {
  return textCollator.compare(left, right);
}

function comparePhone(left: string, right: string): number {
  const leftDigits = normalizedPhoneDigits(left);
  const rightDigits = normalizedPhoneDigits(right);
  if (!leftDigits && !rightDigits) return 0;
  if (!leftDigits) return 1;
  if (!rightDigits) return -1;

  const leftNumber = leftDigits.replace(/^0+/, "") || "0";
  const rightNumber = rightDigits.replace(/^0+/, "") || "0";
  return (
    leftNumber.length - rightNumber.length ||
    compareText(leftNumber, rightNumber)
  );
}

export function compareGuests(
  left: SortableGuest,
  right: SortableGuest,
  field: GuestSortField
): number {
  const primary =
    field === "phone"
      ? comparePhone(left.phone, right.phone)
      : compareText(left.name, right.name);
  return (
    primary ||
    compareText(left.name, right.name) ||
    compareText(left.ticket, right.ticket) ||
    compareText(left.id, right.id)
  );
}

export function sortGuests<T extends SortableGuest>(
  guests: readonly T[],
  field: GuestSortField
): T[] {
  return [...guests].sort((left, right) => compareGuests(left, right, field));
}
