//! Local image staging for the desktop composer.
//!
//! Adapted from Comet's GPUI attachment intake at pinned commit
//! b033110d087ae0f1d1ba607b77d97624165c1986. Scotty sends Pi-native image
//! content instead of Comet host paths. Local paths and file names stay in the
//! Rust process and never enter the sidecar command.

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use gpui::{Image, ImageFormat};

pub const MAX_IMAGE_COUNT: usize = 4;
pub const MAX_TOTAL_IMAGE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct StagedAttachment {
    pub id: String,
    pub name: String,
    pub image: Arc<Image>,
}

impl StagedAttachment {
    pub fn byte_len(&self) -> usize {
        self.image.bytes.len()
    }

    pub fn encoded(&self) -> EncodedAttachment {
        EncodedAttachment {
            data: BASE64.encode(&self.image.bytes),
            mime_type: self.image.format.mime_type(),
        }
    }
}

pub struct EncodedAttachment {
    pub data: String,
    pub mime_type: &'static str,
}

pub fn stage_file(path: &Path) -> Result<StagedAttachment, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "image".to_string());
    let metadata = std::fs::metadata(path).map_err(|_| format!("{name} could not be read."))?;
    if !metadata.is_file() {
        return Err(format!("{name} is not a file."));
    }
    if metadata.len() > MAX_TOTAL_IMAGE_BYTES as u64 {
        return Err(format!("{name} is too large (5 MB total limit)."));
    }
    let bytes = std::fs::read(path).map_err(|_| format!("{name} could not be read."))?;
    let format = sniff_format(&bytes).ok_or_else(|| format!("{name} is not a supported image."))?;
    Ok(StagedAttachment {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        image: Arc::new(Image::from_bytes(format, bytes)),
    })
}

pub fn add_staged(
    current: &mut Vec<StagedAttachment>,
    candidates: Vec<StagedAttachment>,
) -> Vec<String> {
    let mut errors = Vec::new();
    let mut total = current
        .iter()
        .map(StagedAttachment::byte_len)
        .sum::<usize>();
    for candidate in candidates {
        if current.len() >= MAX_IMAGE_COUNT {
            errors.push(format!("Only {MAX_IMAGE_COUNT} images can be attached."));
            break;
        }
        if total.saturating_add(candidate.byte_len()) > MAX_TOTAL_IMAGE_BYTES {
            errors.push("Attached images exceed the 5 MB total limit.".to_string());
            continue;
        }
        total += candidate.byte_len();
        current.push(candidate);
    }
    errors
}

fn sniff_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(ImageFormat::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(id: &str, bytes: Vec<u8>) -> StagedAttachment {
        StagedAttachment {
            id: id.to_string(),
            name: format!("{id}.png"),
            image: Arc::new(Image::from_bytes(ImageFormat::Png, bytes)),
        }
    }

    #[test]
    fn sniffs_only_pi_supported_raster_images() {
        assert_eq!(
            sniff_format(b"\x89PNG\r\n\x1a\nrest"),
            Some(ImageFormat::Png)
        );
        assert_eq!(sniff_format(b"\xff\xd8\xffrest"), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_format(b"GIF89arest"), Some(ImageFormat::Gif));
        assert_eq!(sniff_format(b"RIFF0000WEBPrest"), Some(ImageFormat::Webp));
        assert_eq!(sniff_format(b"<svg></svg>"), None);
        assert_eq!(sniff_format(b"not an image"), None);
    }

    #[test]
    fn attachment_count_and_total_bytes_are_bounded() {
        let mut current = vec![staged("one", vec![0; MAX_TOTAL_IMAGE_BYTES - 1])];
        let errors = add_staged(&mut current, vec![staged("two", vec![0; 2])]);
        assert_eq!(current.len(), 1);
        assert_eq!(errors, ["Attached images exceed the 5 MB total limit."]);

        let mut current = (0..MAX_IMAGE_COUNT)
            .map(|index| staged(&index.to_string(), vec![index as u8]))
            .collect();
        let errors = add_staged(&mut current, vec![staged("extra", vec![1])]);
        assert_eq!(current.len(), MAX_IMAGE_COUNT);
        assert_eq!(errors, ["Only 4 images can be attached."]);
    }

    #[test]
    fn encoding_contains_only_mime_and_base64_data() {
        let attachment = staged("private-path-name", b"secret image bytes".to_vec());
        let encoded = attachment.encoded();
        assert_eq!(encoded.mime_type, "image/png");
        assert_eq!(BASE64.decode(encoded.data).unwrap(), b"secret image bytes");
    }
}
