export const PARTICIPANT_SESSION_SECONDS = 20 * 60 * 60;
export const PARTICIPANT_COOKIE = "eventflow_participant_session";
export type TemporaryParticipant = {
  id: string;
  role: "participant";
  issuedAt: string;
  expiresAt: string;
};
export type ParticipantStatus = {
  session: TemporaryParticipant | null;
  serverNow: string;
  expired?: boolean;
};
