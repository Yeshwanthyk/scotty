import type { BackupIdentity, BackupProof } from "./authority";

export const confirmedBackup = (backup: BackupProof): BackupIdentity | null => {
  const confirmed = backup.confirmed ?? backup.prepared;
  return confirmed !== null &&
    confirmed.confirmedAt !== null &&
    confirmed.backupId === backup.currentBackupId
    ? confirmed
    : null;
};
