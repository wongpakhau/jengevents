import { describe, expect, it } from "vitest";
import { normalizedPhoneDigits, sortGuests } from "./guest-sort";

type TestGuest = {
  id: string;
  name: string;
  phone: string;
  ticket: string;
};

const guest = (
  id: string,
  name: string,
  phone: string,
  ticket: string
): TestGuest => ({ id, name, phone, ticket });

describe("sortGuests", () => {
  it("sorts phone numbers by normalized numeric digits and puts empty phones last", () => {
    const guests = [
      guest("empty", "Empty", "", "T-1"),
      guest("twenty", "Twenty", "+852 20-0000", "T-2"),
      guest("nine", "Nine", "9", "T-3"),
      guest("one", "One", "001", "T-4"),
    ];

    expect(sortGuests(guests, "phone").map(item => item.id)).toEqual([
      "one",
      "nine",
      "twenty",
      "empty",
    ]);
    expect(normalizedPhoneDigits("+852 (123) 456-789")).toBe("852123456789");
  });

  it("uses name, ticket, and id as deterministic tie-breakers", () => {
    const guests = [
      guest("b", "Same", "555", "T-2"),
      guest("c", "Same", "555", "T-1"),
      guest("a", "Same", "555", "T-1"),
    ];

    expect(sortGuests(guests, "phone").map(item => item.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("keeps name as the default sort field while using ticket and id for ties", () => {
    const guests = [
      guest("b", "Bravo", "", "T-2"),
      guest("a", "Alpha", "", "T-3"),
      guest("c", "Bravo", "", "T-1"),
    ];

    expect(sortGuests(guests, "name").map(item => item.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});
