terraform {
  required_version = ">= 1.14, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  backend "local" {}
}
provider "google" { project = var.project_id }
variable "project_id" { type = string }
variable "issue_number" {
  type        = number
  description = "GitHub Issue number. Used to scope Cloud Run service names to avoid cross-Issue collisions."
}
variable "image" { type = string }
variable "ticket_secret_version" {
  type    = string
  default = "1"
}
locals {
  region = "asia-northeast1"
  suffix = "-i${var.issue_number}"
}
resource "google_cloud_run_v2_service" "service" {
  for_each            = toset(["api", "pii-fallback"])
  project             = var.project_id
  name                = "soroeru-${each.key}${local.suffix}"
  location            = local.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"
  scaling {
    min_instance_count = 0
    max_instance_count = 1
  }
  template {
    service_account                  = "soroeru-${each.key}-dev@${var.project_id}.iam.gserviceaccount.com"
    max_instance_request_concurrency = each.key == "pii-fallback" ? 1 : 20
    timeout                          = "30s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = var.image
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
      env {
        name  = "SOROERU_SERVICE"
        value = each.key
      }
      env {
        name = "TIER3_TICKET_KEY"
        value_source {
          secret_key_ref {
            secret  = "tier3-ticket-key"
            version = var.ticket_secret_version
          }
        }
      }
      ports { container_port = 8080 }
    }
  }
}
output "api_url" { value = google_cloud_run_v2_service.service["api"].uri }
output "fallback_url" { value = google_cloud_run_v2_service.service["pii-fallback"].uri }
