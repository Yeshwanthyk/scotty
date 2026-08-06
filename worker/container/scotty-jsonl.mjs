const LF = 0x0a;
const CR = 0x0d;

export const createLfRecordParser = (onRecord) => {
  let pending = Buffer.alloc(0);

  const emit = (record) => {
    const end = record.at(-1) === CR ? record.length - 1 : record.length;
    onRecord(record.subarray(0, end));
  };

  return {
    push(chunk) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let start = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (pending[index] !== LF) continue;
        emit(pending.subarray(start, index));
        start = index + 1;
      }
      pending = pending.subarray(start);
    },
    end() {
      if (pending.length > 0) emit(pending);
      pending = Buffer.alloc(0);
    },
  };
};
