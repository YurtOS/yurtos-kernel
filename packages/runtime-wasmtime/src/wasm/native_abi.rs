//! Native ABI record helpers for Wasmtime host imports.
//!
//! This module owns byte-level validation for variable-size records on the
//! Rust backend. Callers pass the guest-memory bytes already read through
//! `wasmtime::Caller`; all offset arithmetic and UTF-8 checks happen here.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSpawnRequest {
    pub prog: String,
    pub argv0: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub stdin_fd: i32,
    pub stdout_fd: i32,
    pub stderr_fd: i32,
    pub pass_fds: Vec<i32>,
    pub fd_map: Vec<(i32, i32)>,
    pub stdin_data: Option<String>,
    pub nice: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAbiError {
    Invalid,
    Overflow,
}

impl NativeAbiError {
    pub fn errno(self) -> i32 {
        match self {
            Self::Invalid => -22,
            Self::Overflow => -75,
        }
    }
}

const RECORD_VERSION_1: u16 = 1;
const SPAWN_REQUEST_V1_SIZE: usize = 88;
const HEADER_SIZE_OFF: usize = 0;
const HEADER_VERSION_OFF: usize = 4;
const PROG_OFF: usize = 8;
const ARGV0_OFF: usize = 16;
const ARGS_VEC_OFF: usize = 24;
const ARGS_COUNT_OFF: usize = 28;
const ENV_VEC_OFF: usize = 32;
const ENV_COUNT_OFF: usize = 36;
const CWD_OFF: usize = 40;
const STDIN_FD_OFF: usize = 48;
const STDOUT_FD_OFF: usize = 52;
const STDERR_FD_OFF: usize = 56;
const PASS_FDS_OFF: usize = 60;
const PASS_FDS_COUNT_OFF: usize = 64;
const STDIN_DATA_OFF: usize = 68;
const NICE_OFF: usize = 76;
const FD_MAP_OFF: usize = 80;
const FD_MAP_COUNT_OFF: usize = 84;
const SPAN_SIZE: usize = 8;
const ENV_PAIR_SIZE: usize = 16;
const FD_MAP_PAIR_SIZE: usize = 8;

pub fn decode_spawn_request(bytes: &[u8]) -> Result<NativeSpawnRequest, NativeAbiError> {
    if bytes.len() < SPAWN_REQUEST_V1_SIZE {
        return Err(NativeAbiError::Invalid);
    }
    let logical_size = read_u32(bytes, HEADER_SIZE_OFF)? as usize;
    let version = read_u16(bytes, HEADER_VERSION_OFF)?;
    if version != RECORD_VERSION_1 || logical_size < SPAWN_REQUEST_V1_SIZE {
        return Err(NativeAbiError::Invalid);
    }
    if logical_size > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let record = &bytes[..logical_size];

    let prog = read_required_string(record, PROG_OFF)?;
    let argv0 = read_optional_string(record, ARGV0_OFF)?;
    let cwd = read_optional_string(record, CWD_OFF)?;
    let stdin_data = read_optional_string(record, STDIN_DATA_OFF)?;
    let args = read_string_vec(
        record,
        read_u32(record, ARGS_VEC_OFF)?,
        read_u32(record, ARGS_COUNT_OFF)?,
    )?;
    let env = read_env_vec(
        record,
        read_u32(record, ENV_VEC_OFF)?,
        read_u32(record, ENV_COUNT_OFF)?,
    )?;
    let pass_fds = read_i32_vec(
        record,
        read_u32(record, PASS_FDS_OFF)?,
        read_u32(record, PASS_FDS_COUNT_OFF)?,
    )?;
    let fd_map = read_fd_map_vec(
        record,
        read_u32(record, FD_MAP_OFF)?,
        read_u32(record, FD_MAP_COUNT_OFF)?,
    )?;

    Ok(NativeSpawnRequest {
        prog,
        argv0,
        args,
        env,
        cwd,
        stdin_fd: read_i32(record, STDIN_FD_OFF)?,
        stdout_fd: read_i32(record, STDOUT_FD_OFF)?,
        stderr_fd: read_i32(record, STDERR_FD_OFF)?,
        pass_fds,
        fd_map,
        stdin_data,
        nice: read_i32(record, NICE_OFF)?,
    })
}

fn read_u16(bytes: &[u8], off: usize) -> Result<u16, NativeAbiError> {
    let end = off.checked_add(2).ok_or(NativeAbiError::Overflow)?;
    let slice = bytes.get(off..end).ok_or(NativeAbiError::Invalid)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], off: usize) -> Result<u32, NativeAbiError> {
    let end = off.checked_add(4).ok_or(NativeAbiError::Overflow)?;
    let slice = bytes.get(off..end).ok_or(NativeAbiError::Invalid)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32(bytes: &[u8], off: usize) -> Result<i32, NativeAbiError> {
    Ok(read_u32(bytes, off)? as i32)
}

fn read_span(bytes: &[u8], off: usize) -> Result<(usize, usize), NativeAbiError> {
    let span_off = read_u32(bytes, off)? as usize;
    let len = read_u32(bytes, off + 4)? as usize;
    if span_off == 0 && len == 0 {
        return Ok((0, 0));
    }
    if !span_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let end = span_off.checked_add(len).ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    Ok((span_off, len))
}

fn read_required_string(bytes: &[u8], off: usize) -> Result<String, NativeAbiError> {
    let (span_off, len) = read_span(bytes, off)?;
    if len == 0 {
        return Err(NativeAbiError::Invalid);
    }
    let s = std::str::from_utf8(&bytes[span_off..span_off + len])
        .map_err(|_| NativeAbiError::Invalid)?;
    Ok(s.to_owned())
}

fn read_string(bytes: &[u8], off: usize) -> Result<String, NativeAbiError> {
    let (span_off, len) = read_span(bytes, off)?;
    let s = std::str::from_utf8(&bytes[span_off..span_off + len])
        .map_err(|_| NativeAbiError::Invalid)?;
    Ok(s.to_owned())
}

fn read_optional_string(bytes: &[u8], off: usize) -> Result<Option<String>, NativeAbiError> {
    let span_off = read_u32(bytes, off)? as usize;
    let len = read_u32(bytes, off + 4)? as usize;
    if span_off == 0 && len == 0 {
        return Ok(None);
    }
    if !span_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let end = span_off.checked_add(len).ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let s = std::str::from_utf8(&bytes[span_off..span_off + len])
        .map_err(|_| NativeAbiError::Invalid)?;
    Ok(Some(s.to_owned()))
}

fn read_string_vec(bytes: &[u8], vec_off: u32, count: u32) -> Result<Vec<String>, NativeAbiError> {
    let vec_off = vec_off as usize;
    let count = count as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    if vec_off == 0 || !vec_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let byte_len = count
        .checked_mul(SPAN_SIZE)
        .ok_or(NativeAbiError::Overflow)?;
    let end = vec_off
        .checked_add(byte_len)
        .ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_string(bytes, vec_off + i * SPAN_SIZE)?);
    }
    Ok(out)
}

fn read_env_vec(
    bytes: &[u8],
    vec_off: u32,
    count: u32,
) -> Result<Vec<(String, String)>, NativeAbiError> {
    let vec_off = vec_off as usize;
    let count = count as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    if vec_off == 0 || !vec_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let byte_len = count
        .checked_mul(ENV_PAIR_SIZE)
        .ok_or(NativeAbiError::Overflow)?;
    let end = vec_off
        .checked_add(byte_len)
        .ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let off = vec_off + i * ENV_PAIR_SIZE;
        let key = read_required_string(bytes, off)?;
        let value = read_string(bytes, off + SPAN_SIZE)?;
        out.push((key, value));
    }
    Ok(out)
}

fn read_i32_vec(bytes: &[u8], vec_off: u32, count: u32) -> Result<Vec<i32>, NativeAbiError> {
    let vec_off = vec_off as usize;
    let count = count as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    if vec_off == 0 || !vec_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let byte_len = count.checked_mul(4).ok_or(NativeAbiError::Overflow)?;
    let end = vec_off
        .checked_add(byte_len)
        .ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(read_i32(bytes, vec_off + i * 4)?);
    }
    Ok(out)
}

fn read_fd_map_vec(
    bytes: &[u8],
    vec_off: u32,
    count: u32,
) -> Result<Vec<(i32, i32)>, NativeAbiError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let vec_off = vec_off as usize;
    let count = count as usize;
    if vec_off == 0 || !vec_off.is_multiple_of(4) {
        return Err(NativeAbiError::Invalid);
    }
    let byte_len = count
        .checked_mul(FD_MAP_PAIR_SIZE)
        .ok_or(NativeAbiError::Overflow)?;
    let end = vec_off
        .checked_add(byte_len)
        .ok_or(NativeAbiError::Overflow)?;
    if end > bytes.len() {
        return Err(NativeAbiError::Overflow);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let off = vec_off + i * FD_MAP_PAIR_SIZE;
        out.push((read_i32(bytes, off)?, read_i32(bytes, off + 4)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SpawnRecordBuilder {
        bytes: Vec<u8>,
    }

    impl SpawnRecordBuilder {
        fn new() -> Self {
            Self {
                bytes: vec![0; SPAWN_REQUEST_V1_SIZE],
            }
        }

        fn finish(mut self) -> Vec<u8> {
            let size = self.bytes.len() as u32;
            put_u32(&mut self.bytes, HEADER_SIZE_OFF, size);
            put_u16(&mut self.bytes, HEADER_VERSION_OFF, RECORD_VERSION_1);
            self.bytes
        }

        fn align4(&mut self) {
            while !self.bytes.len().is_multiple_of(4) {
                self.bytes.push(0);
            }
        }

        fn span(&mut self, field_off: usize, value: &str) {
            self.align4();
            let off = self.bytes.len();
            self.bytes.extend_from_slice(value.as_bytes());
            put_u32(&mut self.bytes, field_off, off as u32);
            put_u32(&mut self.bytes, field_off + 4, value.len() as u32);
        }

        fn args(&mut self, values: &[&str]) {
            self.align4();
            let vec_off = self.bytes.len();
            self.bytes.resize(vec_off + values.len() * SPAN_SIZE, 0);
            for (index, value) in values.iter().enumerate() {
                self.span(vec_off + index * SPAN_SIZE, value);
            }
            put_u32(&mut self.bytes, ARGS_VEC_OFF, vec_off as u32);
            put_u32(&mut self.bytes, ARGS_COUNT_OFF, values.len() as u32);
        }

        fn env(&mut self, values: &[(&str, &str)]) {
            self.align4();
            let vec_off = self.bytes.len();
            self.bytes.resize(vec_off + values.len() * ENV_PAIR_SIZE, 0);
            for (index, (key, value)) in values.iter().enumerate() {
                let off = vec_off + index * ENV_PAIR_SIZE;
                self.span(off, key);
                self.span(off + SPAN_SIZE, value);
            }
            put_u32(&mut self.bytes, ENV_VEC_OFF, vec_off as u32);
            put_u32(&mut self.bytes, ENV_COUNT_OFF, values.len() as u32);
        }

        fn fd_map(&mut self, values: &[(i32, i32)]) {
            self.align4();
            let vec_off = self.bytes.len();
            self.bytes
                .resize(vec_off + values.len() * FD_MAP_PAIR_SIZE, 0);
            for (index, (parent_fd, child_fd)) in values.iter().enumerate() {
                let off = vec_off + index * FD_MAP_PAIR_SIZE;
                put_i32(&mut self.bytes, off, *parent_fd);
                put_i32(&mut self.bytes, off + 4, *child_fd);
            }
            put_u32(&mut self.bytes, FD_MAP_OFF, vec_off as u32);
            put_u32(&mut self.bytes, FD_MAP_COUNT_OFF, values.len() as u32);
        }
    }

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i32(bytes: &mut [u8], off: usize, value: i32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn decodes_spawn_record() {
        let mut builder = SpawnRecordBuilder::new();
        builder.span(PROG_OFF, "echo");
        builder.span(ARGV0_OFF, "busybox");
        builder.args(&["hello", "world"]);
        builder.env(&[("PATH", "/bin"), ("PWD", "/tmp")]);
        builder.span(CWD_OFF, "/tmp");
        builder.span(STDIN_DATA_OFF, "input");
        builder.fd_map(&[(3, 7), (8, 9)]);
        put_i32(&mut builder.bytes, STDIN_FD_OFF, 0);
        put_i32(&mut builder.bytes, STDOUT_FD_OFF, 1);
        put_i32(&mut builder.bytes, STDERR_FD_OFF, 2);
        put_i32(&mut builder.bytes, NICE_OFF, 5);

        let decoded = decode_spawn_request(&builder.finish()).unwrap();
        assert_eq!(decoded.prog, "echo");
        assert_eq!(decoded.argv0.as_deref(), Some("busybox"));
        assert_eq!(decoded.args, ["hello", "world"]);
        assert_eq!(
            decoded.env,
            [
                ("PATH".to_owned(), "/bin".to_owned()),
                ("PWD".to_owned(), "/tmp".to_owned())
            ],
        );
        assert_eq!(decoded.cwd.as_deref(), Some("/tmp"));
        assert_eq!(decoded.stdin_data.as_deref(), Some("input"));
        assert_eq!(decoded.stdout_fd, 1);
        assert_eq!(decoded.fd_map, [(3, 7), (8, 9)]);
        assert_eq!(decoded.nice, 5);
    }

    #[test]
    fn decodes_present_empty_argv0_and_args() {
        let mut builder = SpawnRecordBuilder::new();
        builder.span(PROG_OFF, "zsh");
        builder.span(ARGV0_OFF, "");
        builder.args(&["", "arg"]);

        let decoded = decode_spawn_request(&builder.finish()).unwrap();
        assert_eq!(decoded.argv0.as_deref(), Some(""));
        assert_eq!(decoded.args, ["", "arg"]);
    }

    #[test]
    fn rejects_out_of_bounds_span() {
        let mut builder = SpawnRecordBuilder::new();
        builder.span(PROG_OFF, "echo");
        let mut bytes = builder.finish();
        put_u32(&mut bytes, PROG_OFF, 1_000_000);
        assert_eq!(decode_spawn_request(&bytes), Err(NativeAbiError::Overflow));
    }

    #[test]
    fn rejects_invalid_utf8() {
        let mut builder = SpawnRecordBuilder::new();
        builder.align4();
        let off = builder.bytes.len();
        builder.bytes.extend_from_slice(&[0xff, 0xff]);
        put_u32(&mut builder.bytes, PROG_OFF, off as u32);
        put_u32(&mut builder.bytes, PROG_OFF + 4, 2);
        assert_eq!(
            decode_spawn_request(&builder.finish()),
            Err(NativeAbiError::Invalid)
        );
    }

    #[test]
    fn rejects_unknown_version() {
        let mut builder = SpawnRecordBuilder::new();
        builder.span(PROG_OFF, "echo");
        let mut bytes = builder.finish();
        put_u16(&mut bytes, HEADER_VERSION_OFF, 99);
        assert_eq!(decode_spawn_request(&bytes), Err(NativeAbiError::Invalid));
    }
}
