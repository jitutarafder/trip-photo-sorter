import ExpoModulesCore
import Vision
import UIKit
import Photos

public class AppleVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppleVision")

    AsyncFunction("detectFaces") { (imageUri: String) -> [[String: Any]] in
      return self.detectFacesInUri(imageUri)
    }

    AsyncFunction("setExcludedFromBackup") { (filePath: String) -> Bool in
      return self.setExcludedFromBackup(path: filePath)
    }

    AsyncFunction("isExcludedFromBackup") { (filePath: String) -> Bool in
      return self.isExcludedFromBackup(path: filePath)
    }

    OnCreate {
      _ = (NSClassFromString("TurboModuleCrashGuard") as AnyObject?)?.perform(NSSelectorFromString("install"))
    }
  }

  private func detectFacesInUri(_ imageUri: String) -> [[String: Any]] {
    var targetImage: UIImage? = nil

    if imageUri.hasPrefix("ph://") {
      let localId = String(imageUri.dropFirst(5))
      targetImage = self.loadImageFromPhotoKit(localIdentifier: localId)
    } else if let url = URL(string: imageUri), url.isFileURL {
      targetImage = UIImage(contentsOfFile: url.path)
    } else {
      targetImage = UIImage(contentsOfFile: imageUri)
    }

    if targetImage == nil, let url = URL(string: imageUri), let data = try? Data(contentsOf: url) {
      targetImage = UIImage(data: data)
    }

    guard let img = targetImage, let cgImage = img.cgImage else {
      return []
    }

    let orientation = self.cgImageOrientation(from: img.imageOrientation)
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
    let request = VNDetectFaceRectanglesRequest()

    if #available(iOS 15.0, *) {
      request.revision = VNDetectFaceRectanglesRequestRevision3
    }

    do {
      try handler.perform([request])
    } catch {
      return []
    }

    guard let results = request.results else {
      return []
    }

    let imageWidth = Double(cgImage.width)
    let imageHeight = Double(cgImage.height)

    var faces: [[String: Any]] = []
    for observation in results {
      let box = observation.boundingBox
      // Vision coordinates: (0,0) at bottom-left, normalized 0.0 - 1.0.
      // Convert to standard (0,0) top-left normalized coordinates.
      let normX = Double(box.origin.x)
      let normY = Double(1.0 - box.origin.y - box.height)
      let normWidth = Double(box.width)
      let normHeight = Double(box.height)

      var faceDict: [String: Any] = [
        "x": max(0.0, min(1.0, normX)),
        "y": max(0.0, min(1.0, normY)),
        "width": max(0.0, min(1.0, normWidth)),
        "height": max(0.0, min(1.0, normHeight)),
        "pixelX": normX * imageWidth,
        "pixelY": normY * imageHeight,
        "pixelWidth": normWidth * imageWidth,
        "pixelHeight": normHeight * imageHeight,
        "confidence": Double(observation.confidence)
      ]

      if let roll = observation.roll {
        faceDict["roll"] = roll.doubleValue
      }
      if let yaw = observation.yaw {
        faceDict["yaw"] = yaw.doubleValue
      }
      if #available(iOS 13.0, *), let quality = observation.faceCaptureQuality {
        faceDict["captureQuality"] = Double(quality)
      }

      faces.append(faceDict)
    }

    return faces
  }

  private func loadImageFromPhotoKit(localIdentifier: String) -> UIImage? {
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    guard let asset = fetchResult.firstObject else {
      return nil
    }

    let options = PHImageRequestOptions()
    options.isSynchronous = true
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = false

    var resultImage: UIImage? = nil
    let targetSize = CGSize(width: 1920, height: 1920)

    PHImageManager.default().requestImage(
      for: asset,
      targetSize: targetSize,
      contentMode: .aspectFit,
      options: options
    ) { image, _ in
      resultImage = image
    }

    return resultImage
  }

  private func cgImageOrientation(from orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch orientation {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }

  private func resolveFileUrl(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) {
      return url
    }
    return URL(fileURLWithPath: path)
  }

  private func setExcludedFromBackup(path: String) -> Bool {
    let fileUrl = resolveFileUrl(path)
    let fileManager = FileManager.default

    if !fileManager.fileExists(atPath: fileUrl.path) {
      if path.hasSuffix("/") {
        try? fileManager.createDirectory(at: fileUrl, withIntermediateDirectories: true, attributes: nil)
      } else {
        let parent = fileUrl.deletingLastPathComponent()
        if !fileManager.fileExists(atPath: parent.path) {
          try? fileManager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: nil)
        }
      }
    }

    guard fileManager.fileExists(atPath: fileUrl.path) else {
      return false
    }

    do {
      var urlToSet = fileUrl
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      try urlToSet.setResourceValues(resourceValues)
      return true
    } catch {
      return false
    }
  }

  private func isExcludedFromBackup(path: String) -> Bool {
    let fileUrl = resolveFileUrl(path)
    guard FileManager.default.fileExists(atPath: fileUrl.path) else {
      return false
    }
    do {
      let values = try fileUrl.resourceValues(forKeys: [.isExcludedFromBackupKey])
      return values.isExcludedFromBackup ?? false
    } catch {
      return false
    }
  }
}
