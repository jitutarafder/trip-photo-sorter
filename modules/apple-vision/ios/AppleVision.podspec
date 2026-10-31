require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AppleVision'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'TripPhotoSorter'
  s.homepage       = 'https://github.com/jitutarafder/trip-photo-sorter'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Vision', 'UIKit', 'Photos'
end
