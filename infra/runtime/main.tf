terraform {
  required_version = ">= 1.14, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  backend "gcs" {}
}
provider "google" { project = var.project_id }
variable "project_id" { type = string }
variable "image" { type = string }
variable "ticket_secret_version" {
  type    = string
  default = "1"
}
variable "gemini_daily_limit" {
  type    = number
  default = 100
  validation {
    condition     = var.gemini_daily_limit >= 1 && floor(var.gemini_daily_limit) == var.gemini_daily_limit
    error_message = "Daily limit must be a positive integer."
  }
}
variable "gemini_model_id" {
  type        = string
  default     = ""
  description = "Explicit regional Vertex Gemini model ID; empty disables Tier 2."
}
locals { region = "asia-northeast1" }
resource "google_vertex_ai_cache_config" "privacy" {
  project       = var.project_id
  disable_cache = true
}
resource "google_firestore_database" "schemas" {
  project                 = var.project_id
  name                    = "(default)"
  location_id             = local.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
}
resource "google_logging_project_exclusion" "requests" {
  project     = var.project_id
  name        = "soroeru-cloud-no-request-logs"
  description = "Do not retain caller IP, URL or request metadata for either Soroeru service."
  filter      = "resource.type=\"cloud_run_revision\" AND (resource.labels.service_name=\"soroeru-api\" OR resource.labels.service_name=\"soroeru-pii-fallback\") AND (log_id(\"run.googleapis.com/requests\") OR log_id(\"run.googleapis.com/varlog/system\"))"
}
resource "google_cloud_run_v2_service" "service" {
  for_each             = toset(["api", "pii-fallback"])
  project              = var.project_id
  name                 = "soroeru-${each.key}"
  location             = local.region
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  scaling {
    min_instance_count = 0
    max_instance_count = each.key == "pii-fallback" ? 1 : 2
  }
  template {
    service_account                  = "soroeru-${each.key}@${var.project_id}.iam.gserviceaccount.com"
    max_instance_request_concurrency = each.key == "pii-fallback" ? 1 : 20
    timeout                          = "30s"
    scaling {
      min_instance_count = 0
      max_instance_count = each.key == "pii-fallback" ? 1 : 2
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
        name  = "GEMINI_DAILY_LIMIT"
        value = tostring(var.gemini_daily_limit)
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GEMINI_LOCATION"
        value = local.region
      }
      env {
        name  = "GEMINI_MODEL_ID"
        value = var.gemini_model_id
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
  depends_on = [google_logging_project_exclusion.requests, google_firestore_database.schemas]
}
output "api_url" { value = google_cloud_run_v2_service.service["api"].uri }
output "fallback_url" { value = google_cloud_run_v2_service.service["pii-fallback"].uri }
