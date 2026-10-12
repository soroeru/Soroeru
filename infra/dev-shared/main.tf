terraform {
  required_version = ">= 1.14, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  backend "local" {
    path = "../../state/dev-shared/terraform.tfstate"
  }
}
provider "google" { project = var.project_id }
variable "project_id" { type = string }
locals { region = "asia-northeast1" }
resource "google_firestore_database" "schemas" {
  project                 = var.project_id
  name                    = "(default)"
  location_id             = local.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
  deletion_policy         = "DELETE"
}
resource "google_logging_project_exclusion" "requests" {
  project     = var.project_id
  name        = "soroeru-cloud-no-request-logs"
  description = "Do not retain caller IP, URL or request metadata for either Soroeru service."
  filter      = "resource.type=\"cloud_run_revision\" AND (resource.labels.service_name=\"soroeru-api\" OR resource.labels.service_name=\"soroeru-pii-fallback\") AND (log_id(\"run.googleapis.com/requests\") OR log_id(\"run.googleapis.com/varlog/system\"))"
}
resource "google_service_account" "runner" {
  for_each     = toset(["api", "pii-fallback"])
  project      = var.project_id
  account_id   = "soroeru-${each.key}-dev"
  display_name = "Soroeru ${each.key} dev runner"
}
